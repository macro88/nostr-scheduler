import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { LocalRelay } from "../src/test-relay/relay.ts";

const dataDir = "e2e/run";
const example = readFileSync(new URL("../examples/criteria/example-profile.md", import.meta.url), "utf8");

function profileFile(signer: { npub: string; pubkey: string }, relay: string) {
  mkdirSync(`${dataDir}/criteria`, { recursive: true });
  writeFileSync(`${dataDir}/criteria/demo.md`, example.replace("profile_id: example", "profile_id: demo"));
  writeFileSync(
    `${dataDir}/profiles.yaml`,
    [
      "profiles:",
      "  - id: demo",
      "    label: Demo",
      `    npub: ${signer.npub}`,
      `    pubkey: ${signer.pubkey}`,
      "    suggester_id: demo-suggester",
      "    signer:",
      "      kind: mock",
      "    relays:",
      `      - ${relay}`,
      "    read_nip65: false",
      "    criteria_path: criteria/demo.md",
      "",
    ].join("\n"),
  );
}

async function post(page: Page, path: string, payload: unknown) {
  return page.evaluate(
    async ({ path, payload }) => {
      const session = (await fetch("/api/session").then((response) => response.json())) as { token: string };
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": session.token },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    { path, payload },
  );
}

async function clear(page: Page) {
  const existing = (await page.evaluate(async () => {
    const response = await fetch("/api/items?profileId=demo");
    return response.json();
  })) as { id: string; status: string }[];
  for (const item of existing) {
    if (item.status === "suggestion") await post(page, `/api/items/${item.id}/reject`, { reason: "clear" });
    if (["approved", "signed", "queued", "failed"].includes(item.status)) {
      await post(page, `/api/items/${item.id}/discard`, { reason: "clear" });
    }
  }
}

test("keyboard approve, reject with undo, and schedule", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  profileFile(signer, url);
  await page.exposeFunction("__nostrSign", (event: Parameters<typeof signer.signEvent>[0]) => signer.signEvent(event));
  await page.goto("/");
  await clear(page);
  const fireAt = Math.floor(Date.now() / 1000) + 3600;
  await post(page, "/api/suggestions", {
    profileId: "demo",
    rationale: "keys",
    draft: { type: "note", content: "Keyboard note", proposedFireAt: fireAt },
  });
  await page.reload();
  await page.getByTestId("suggestion").focus();
  await page.keyboard.press("a");
  await expect(page.getByTestId("toast-success")).toContainText("Approved");

  await post(page, "/api/suggestions", {
    profileId: "demo",
    rationale: "undo",
    draft: { type: "note", content: "Undo note", proposedFireAt: fireAt },
  });
  await page.reload();
  await page.getByTestId("suggestion").focus();
  await page.keyboard.press("r");
  await page.getByTestId("reject-reason").fill("not now");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("toast-undo")).toBeVisible();
  await page.getByTestId("undo").click();
  await expect(page.getByText("Undo note")).toBeVisible();

  await page.getByTestId("nav-compose").click();
  await page.getByTestId("note-text").fill("Scheduled from the keyboard");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("note-text")).toBeFocused();
  await expect(page.getByTestId("note-text")).toHaveValue("");
  await relay.stop();
});

test("empty, loading, and error states", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  profileFile(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }), url);
  let itemsMode: "empty" | "slow" | "error" = "empty";
  await page.route("**/api/items**", async (route) => {
    const mode = itemsMode;
    if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 700));
    if (mode === "error") {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "database exploded" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route("**/api/log", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto("/");
  await expect(page.getByTestId("empty")).toContainText("Nothing is waiting.");
  await page.getByTestId("nav-calendar").click();
  await expect(page.getByTestId("empty")).toContainText("Nothing is scheduled this week.");
  await page.getByTestId("nav-log").click();
  await expect(page.getByTestId("empty")).toContainText("Nothing has been sent yet.");
  await page.getByTestId("nav-sign").click();
  await expect(page.getByTestId("empty")).toContainText("Nothing is waiting to be signed.");

  itemsMode = "slow";
  await page.getByTestId("nav-inbox").click();
  await page.reload();
  await expect(page.getByTestId("skeleton")).toBeVisible();
  await expect(page.getByText("Nothing is waiting.")).toHaveCount(0);
  await expect(page.getByTestId("empty")).toContainText("Nothing is waiting.");

  itemsMode = "error";
  await page.reload();
  await expect(page.getByTestId("inline-error").locator("p").first()).toContainText("Try again");
  await expect(page.getByTestId("inline-error").locator("p").first()).not.toContainText("exploded");
  await relay.stop();
});

test("axe finds no serious or critical issues", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  profileFile(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }), url);
  await page.goto("/");
  for (const name of ["inbox", "compose", "calendar", "log", "sign"]) {
    await page.getByTestId(`nav-${name}`).click();
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  }
  await relay.stop();
});
