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
  await expect(page.getByTestId("suggestion").filter({ hasText: "Undo note" })).toBeVisible();

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

test("single-key shortcuts turn off and stay out of text fields", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  profileFile(signer, url);
  await page.goto("/");
  await clear(page);
  const fireAt = Math.floor(Date.now() / 1000) + 3600;
  await post(page, "/api/suggestions", {
    profileId: "demo",
    rationale: "keys",
    draft: { type: "note", content: "Shortcut note", proposedFireAt: fireAt },
  });
  await page.reload();
  await page.getByTestId("profile").focus();
  await page.keyboard.press("2");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Inbox");
  await page.getByTestId("shortcuts").uncheck();
  await page.getByTestId("suggestion").focus();
  await page.keyboard.press("a");
  await expect(page.getByTestId("toast-success")).toHaveCount(0);
  await expect(page.getByTestId("suggestion").filter({ hasText: "Shortcut note" })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("shortcuts")).not.toBeChecked();
  await page.getByTestId("shortcuts").check();
  await page.getByTestId("suggestion").focus();
  await page.keyboard.press("a");
  await expect(page.getByTestId("toast-success")).toContainText("Approved");
  await relay.stop();
});

test("discarding a queued item asks first and escape returns to discard", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  profileFile(signer, url);
  await page.exposeFunction("__nostrSign", (event: Parameters<typeof signer.signEvent>[0]) => signer.signEvent(event));
  await page.addInitScript(() => {
    const target = window as Window & {
      nostr?: { signEvent: (event: unknown) => Promise<unknown> };
      __nostrSign?: (event: unknown) => Promise<unknown>;
    };
    target.nostr = {
      signEvent: (event) => {
        if (!target.__nostrSign) throw new Error("missing signer");
        return target.__nostrSign(event);
      },
    };
  });
  await page.goto("/");
  await clear(page);
  const fireAt = Math.floor(Date.now() / 1000) + 3600;
  await post(page, "/api/compose", {
    profileId: "demo",
    draft: { type: "note", content: "Queued for discard", proposedFireAt: fireAt },
  });
  await page.getByTestId("nav-sign").click();
  await page.getByTestId("sign-browser").click();
  await expect(page.getByTestId("sign-status")).toContainText("Queued");
  await page.getByTestId("nav-calendar").click();
  await page.getByTestId("calendar-item").filter({ hasText: "Queued for discard" }).click();
  await expect(page.getByTestId("frozen-note")).toBeVisible();
  await page.getByTestId("discard").click();
  const dialog = page.getByTestId("confirm-discard");
  await expect(dialog).toBeVisible();
  const headerInert = await page.locator("header").evaluate((element) => element.matches("[inert], [inert] *"));
  const navInert = await page.getByRole("navigation", { name: "Sections" }).evaluate((element) => element.matches("[inert], [inert] *"));
  const dialogInert = await dialog.evaluate((element) => element.matches("[inert], [inert] *"));
  expect(headerInert).toBe(true);
  expect(navInert).toBe(true);
  expect(dialogInert).toBe(false);
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport && box.y >= 0 && box.y + box.height <= viewport.height + 1).toBe(true);
  await expect(page.getByTestId("confirm-remove")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Keep" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("confirm-remove")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("calendar-detail")).toBeVisible();
  await expect(page.getByTestId("discard")).toBeFocused();
  await relay.stop();
});

async function expectInView(page: Page, testId: string) {
  const item = page.getByTestId(testId);
  await item.scrollIntoViewIfNeeded();
  const box = await item.boundingBox();
  const viewport = page.viewportSize();
  expect(box, testId).toBeTruthy();
  expect(viewport, "viewport").toBeTruthy();
  if (!box || !viewport) return;
  expect(box.x, testId).toBeGreaterThanOrEqual(-1);
  expect(box.y, testId).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, testId).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height, testId).toBeLessThanOrEqual(viewport.height + 1);
  const clipped = await item.evaluate((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1);
  expect(clipped, testId).toBe(false);
}

test("narrow screens keep navigation and queue controls reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const relay = new LocalRelay();
  const url = await relay.start();
  profileFile(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }), url);
  await page.goto("/");
  for (const name of ["inbox", "compose", "calendar", "log", "sign"]) await expectInView(page, `nav-${name}`);
  await page.getByTestId("nav-calendar").click();
  for (const name of ["prev", "view-week", "view-day", "next", "publish-due"]) await expectInView(page, name);
  await relay.stop();
});

test("a toast does not cover schedule", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const relay = new LocalRelay();
  const url = await relay.start();
  profileFile(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }), url);
  await page.goto("/");
  await page.getByTestId("nav-compose").click();
  await page.getByTestId("note-text").fill("Short note");
  await page.getByTestId("save-draft").click();
  await expect(page.getByTestId("toast-success")).toBeVisible();
  await page.getByTestId("save-draft").scrollIntoViewIfNeeded();
  const covered = await page.evaluate(() => {
    const toast = document.querySelector("[data-testid=toast-success]")?.getBoundingClientRect();
    const button = document.querySelector("[data-testid=save-draft]")?.getBoundingClientRect();
    if (!toast || !button) return true;
    return button.top < toast.bottom && button.bottom > toast.top && button.left < toast.right && button.right > toast.left;
  });
  expect(covered).toBe(false);
  await relay.stop();
});

test("the time control uses a 24-hour British date and refuses the past", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  profileFile(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }), url);
  await page.goto("/");
  await page.getByTestId("nav-compose").click();
  await expect(page.getByTestId("schedule")).toHaveText(/\w{3} \d{1,2} \w{3}, \d{2}:\d{2}/);
  await page.getByTestId("schedule").click();
  await page.getByTestId("time-hour").press("ArrowUp");
  await page.getByTestId("time-minute").fill("15");
  await page.getByTestId("time-apply").click();
  await expect(page.getByTestId("schedule")).toHaveText(/\w{3} \d{1,2} \w{3}, \d{2}:15/);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await page.getByTestId("schedule").click();
  await page.getByTestId("time-year").fill(String(yesterday.getFullYear()));
  await page.getByTestId("time-month").fill(String(yesterday.getMonth() + 1));
  await page.getByTestId("time-day").fill(String(yesterday.getDate()));
  await page.getByTestId("time-apply").click();
  await page.getByTestId("note-text").fill("too late");
  await page.getByTestId("save-draft").click();
  await expect(page.getByTestId("inline-error")).toContainText("This time is in the past.");
  await relay.stop();
});

test("the page does not load a forbidden typeface", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  profileFile(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }), url);
  await page.goto("/");
  const families = await page.evaluate(() => {
    const nodes = [document.body, document.querySelector("h1"), document.querySelector(".wordmark"), document.querySelector(".editor")].filter(Boolean);
    return nodes.map((node) => getComputedStyle(node as Element).fontFamily).join(" | ");
  });
  expect(families).toContain("Be Vietnam Pro");
  expect(families).not.toMatch(/Inter|Geist|Instrument|Fraunces|Space Grotesk|Public Sans|Source Serif|Roboto/i);
  await relay.stop();
});

test("axe finds no serious or critical issues", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  profileFile(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }), url);
  await page.goto("/");
  for (const name of ["inbox", "compose", "calendar", "log", "sign"]) {
    await page.getByTestId(`nav-${name}`).click();
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      const results = await new AxeBuilder({ page }).analyze();
      const blocking = results.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
      expect(blocking, `${name} ${theme}\n${JSON.stringify(blocking, null, 2)}`).toEqual([]);
    }
  }
  await relay.stop();
});
