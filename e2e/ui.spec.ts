import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { npubFromPubkey } from "../src/domain/bech32.ts";
import { createMockSigner, startMockBunker } from "../src/mock-signer/index.ts";
import { LocalRelay } from "../src/test-relay/relay.ts";

const dataDir = "e2e/run";
const example = readFileSync(new URL("../examples/criteria/example-profile.md", import.meta.url), "utf8");
const mode = { NOSTR_SCHEDULER_MODE: "test" };

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

test.describe.configure({ mode: "serial" });

test("reviews, composes, signs, and publishes on the local relay", async ({ page }) => {
  test.setTimeout(150_000);
  const relay = new LocalRelay();
  const url = await relay.start();
  const signer = createMockSigner(mode);
  profileFile(signer, url);
  const when = new Date(Date.now() + 75 * 1000);
  when.setSeconds(0, 0);
  const fireAt = Math.floor(when.getTime() / 1000);
  const marker = `Root ${fireAt}`;
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
  await post(page, "/api/suggestions", {
    profileId: "demo",
    rationale: "first",
    draft: { type: "note", content: "Alpha note", proposedFireAt: fireAt },
  });
  await post(page, "/api/suggestions", {
    profileId: "demo",
    rationale: "second",
    draft: { type: "note", content: "Beta note", proposedFireAt: fireAt },
  });
  await page.reload();
  await expect(page.getByTestId("suggestion").filter({ hasText: "Alpha note" })).toBeVisible();
  if (process.env.SAVE_UI_SHOTS === "1") await page.screenshot({ path: "/opt/cursor/artifacts/ui-screenshots/inbox.png", fullPage: true });
  await page.getByTestId("edit").click();
  await page.getByTestId("edit-text").fill("Alpha revised");
  await page.getByTestId("save-edit").click();
  await page.getByTestId("approve").click();
  await expect(page.getByTestId("suggestion")).toHaveCount(1);
  await page.getByTestId("reject-open").click();
  await page.getByTestId("reject-reason").fill("off brief");
  await page.getByTestId("reject").click();
  await expect(page.getByText("Nothing is waiting.")).toBeVisible();

  await page.getByTestId("nav-compose").click();
  await page.getByTestId("kind-thread").click();
  await page.getByTestId("schedule").click();
  await page.getByTestId("time-year").fill(String(when.getFullYear()));
  await page.getByTestId("time-month").fill(String(when.getMonth() + 1));
  await page.getByTestId("time-day").fill(String(when.getDate()));
  await page.getByTestId("time-hour").fill(String(when.getHours()));
  await page.getByTestId("time-minute").fill(String(when.getMinutes()));
  await page.getByTestId("time-apply").click();
  const parts = page.getByTestId("thread-part");
  await parts.nth(0).fill(marker);
  await parts.nth(1).fill("Reply line");
  if (process.env.SAVE_UI_SHOTS === "1") await page.screenshot({ path: "/opt/cursor/artifacts/ui-screenshots/composer-thread.png", fullPage: true });
  await page.getByTestId("save-draft").click();
  await expect(page.getByTestId("thread-part").first()).toBeFocused();
  await page.getByTestId("nav-calendar").click();

  await expect(page.getByTestId("week-grid")).toBeVisible();
  await expect(page.getByTestId("calendar-item").filter({ hasText: marker })).toBeVisible();
  if (process.env.SAVE_UI_SHOTS === "1") await page.screenshot({ path: "/opt/cursor/artifacts/ui-screenshots/calendar-week.png", fullPage: true });

  await page.getByTestId("nav-sign").click();
  if (process.env.SAVE_UI_SHOTS === "1") await page.screenshot({ path: "/opt/cursor/artifacts/ui-screenshots/sign-nip07.png", fullPage: true });
  await page.getByTestId("sign-browser").click();
  await expect(page.getByTestId("sign-status")).toContainText("Queued");

  await page.waitForTimeout(Math.max(0, fireAt * 1000 - Date.now()) + 1500);
  await page.getByTestId("nav-calendar").click();
  await page.getByTestId("publish-due").click();
  await expect(page.getByTestId("calendar-item").filter({ hasText: marker }).getByTestId("status-sent")).toBeVisible();
  await page.getByTestId("nav-log").click();
  const logged = page.getByTestId("log-item").filter({ hasText: marker });
  await expect(logged.getByTestId("relay-result").first()).toContainText("Accepted on the local relay.");
  await expect(page.getByTestId("log").locator("summary")).toHaveCount(0);
  if (process.env.SAVE_UI_SHOTS === "1") await page.screenshot({ path: "/opt/cursor/artifacts/ui-screenshots/sent-log.png", fullPage: true });
  await relay.stop();
});

test("pairs a bunker from the sign screen", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  const bunker = await startMockBunker(url, mode);
  profileFile({ npub: npubFromPubkey(bunker.pubkey), pubkey: bunker.pubkey }, url);
  await page.goto("/");
  await page.getByTestId("nav-sign").click();
  await page.getByTestId("bunker-uri").fill(bunker.uri);
  if (process.env.SAVE_UI_SHOTS === "1") {
    await expect(page.getByTestId("pair-qr").locator("svg")).toBeVisible();
    await page.screenshot({ path: "/opt/cursor/artifacts/ui-screenshots/sign-nip46.png", fullPage: true });
  }
  await page.getByTestId("pair").click();
  await expect(page.getByTestId("pair-state")).toContainText("Paired");
  const fireAt = Math.floor(Date.now() / 1000) + 30;
  await post(page, "/api/compose", {
    profileId: "demo",
    draft: { type: "note", content: "Bunker note", proposedFireAt: fireAt },
  });
  await page.getByTestId("sign-bunker").click();
  await expect(page.getByTestId("sign-status")).toContainText("Bunker signed");
  await page.getByTestId("disconnect").click();
  await expect(page.getByTestId("pair-state")).toContainText("Not paired");
  bunker.close();
  await relay.stop();
});
