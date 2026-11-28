import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Page } from "@playwright/test";
import { createMockSigner } from "../src/mock-signer/index.ts";

const dataDir = "e2e/run";

function openData(signer: { npub: string; pubkey: string }) {
  mkdirSync(dataDir, { recursive: true });
  const sqlite = `${dataDir}/app.sqlite`;
  if (existsSync(sqlite)) {
    const db = new DatabaseSync(sqlite);
    db.exec("DELETE FROM work_items");
    db.close();
  }
  writeFileSync(
    `${dataDir}/profiles.yaml`,
    ["profiles:", "  - id: desk", "    label: Desk", `    npub: ${signer.npub}`, `    pubkey: ${signer.pubkey}`, "    suggester_id: desk-suggester", "    signer:", "      kind: nip07", "    relays: []", "    read_nip65: false", "    allow_public_relays: false", ""].join("\n"),
  );
}

async function chooseWhen(page: Page, when: Date) {
  await page.getByTestId("schedule").click();
  await page.getByTestId("time-day").fill(String(when.getDate()));
  await page.getByTestId("time-month").fill(String(when.getMonth() + 1));
  await page.getByTestId("time-year").fill(String(when.getFullYear()));
  await page.getByTestId("time-hour").fill(String(when.getHours()));
  await page.getByTestId("time-minute").fill(String(when.getMinutes()));
  await page.getByTestId("time-apply").click();
  await expect(page.getByTestId("time-picker")).toHaveCount(0);
}

async function items(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/items?profileId=desk");
    return response.json() as Promise<{ id: string; status: string; preview: string; origin: string }[]>;
  });
}

test("saved drafts open in compose, update in place, and leave when scheduled", async ({ page }) => {
  openData(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByTestId("nav-compose").click();
  await expect(page.getByTestId("drafts-empty")).toHaveText("No saved drafts.");
  await expect(page.getByRole("complementary", { name: "Upcoming" }).getByText("No notes in the queue.")).toBeVisible();

  const older = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const newer = new Date(Date.now() + 5 * 60 * 60 * 1000);
  await page.getByTestId("note-text").fill("Older desk note");
  await chooseWhen(page, older);
  const olderWhen = (await page.getByTestId("schedule").innerText()).replace(/\s+/g, " ").trim();
  await page.getByTestId("save-note").click();
  await expect(page.getByTestId("draft-row")).toHaveCount(1);
  await expect(page.getByTestId("draft-row")).toContainText("Older desk note");

  await page.getByTestId("new-draft").click();
  await expect(page.getByTestId("note-text")).toHaveValue("");
  await page.getByTestId("note-text").fill("Newer desk note");
  await chooseWhen(page, newer);
  const newerWhen = (await page.getByTestId("schedule").innerText()).replace(/\s+/g, " ").trim();
  expect(newerWhen).not.toBe(olderWhen);
  await page.getByTestId("save-note").click();
  await expect(page.getByTestId("draft-row")).toHaveCount(2);
  await expect(page.getByTestId("draft-row").nth(0)).toContainText("Older desk note");
  await expect(page.getByTestId("draft-row").nth(1)).toContainText("Newer desk note");

  const olderId = await page.getByTestId("draft-row").nth(0).getAttribute("data-draft-id");
  await page.getByTestId("draft-row").nth(0).click();
  await expect(page.getByTestId("draft-row").nth(0)).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("note-text")).toHaveValue("Older desk note");
  await expect(page.getByTestId("schedule")).toHaveText(olderWhen);
  await page.getByTestId("note-text").fill("Older desk note, edited");
  await page.getByTestId("save-note").click();
  await expect(page.getByTestId("draft-row")).toHaveCount(2);
  await expect(page.getByTestId("draft-row").nth(0)).toContainText("Older desk note, edited");
  await expect(page.getByTestId("draft-row").nth(0)).toHaveAttribute("data-draft-id", olderId ?? "");
  await expect(page.getByTestId("draft-row").nth(1)).toContainText("Newer desk note");

  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Scheduled locally for")).toBeVisible();
  await expect(page.getByTestId("note-text")).toHaveValue("");
  await expect(page.getByTestId("draft-row")).toHaveCount(1);
  await expect(page.getByTestId("draft-row")).toContainText("Newer desk note");
  const rows = await items(page);
  expect(rows.filter((row) => row.preview === "Older desk note, edited").map((row) => ({ status: row.status, origin: row.origin }))).toEqual([
    { status: "approved", origin: "manual" },
  ]);
  expect(rows.filter((row) => row.preview === "Newer desk note").map((row) => row.status)).toEqual(["draft"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

async function paintOpen(page: Page, rows: number) {
  await page.goto("/");
  await expect(page.getByTestId("nav-compose")).toBeVisible();
  const origin = await page.evaluate(() => performance.now());
  await page.getByTestId("nav-compose").click();
  if (rows === 0) await expect(page.getByTestId("drafts-empty")).toBeVisible();
  else await expect(page.getByTestId("draft-row")).toHaveCount(rows);
  await page.waitForFunction(() => performance.getEntriesByName("drafts-list-paint").length > 0, undefined, { timeout: 5_000 });
  return page.evaluate((started) => {
    const paints = performance.getEntriesByName("drafts-list-paint").map((entry) => entry.duration);
    return { openMs: performance.now() - started, paintMs: paints.length === 0 ? null : Math.max(...paints) };
  }, origin);
}

async function seedDrafts(page: Page, count: number) {
  await page.evaluate(async (total) => {
    const session = await fetch("/api/session");
    const token = ((await session.json()) as { token: string }).token;
    const start = Math.floor(Date.now() / 1000) + 120;
    for (let index = 0; index < total; index += 1) {
      const response = await fetch("/api/drafts", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": token },
        body: JSON.stringify({
          profileId: "desk",
          draft: { type: "note", content: `Desk draft ${index}`, proposedFireAt: start + index },
        }),
      });
      if (!response.ok) throw new Error(await response.text());
    }
  }, count);
}

test("fifty saved drafts paint inside the desk budget", async ({ page }) => {
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  const emptyOpen: number[] = [];
  const fiftyOpen: number[] = [];
  const emptyPaint: number[] = [];
  const fiftyPaint: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    openData(signer);
    const empty = await paintOpen(page, 0);
    emptyOpen.push(empty.openMs);
    if (empty.paintMs !== null) emptyPaint.push(empty.paintMs);
    await seedDrafts(page, 50);
    const filled = await paintOpen(page, 50);
    fiftyOpen.push(filled.openMs);
    if (filled.paintMs !== null) fiftyPaint.push(filled.paintMs);
  }
  const paintMedian = median(fiftyPaint);
  const openMedian = median(fiftyOpen);
  const emptyOpenMedian = median(emptyOpen);
  const evidenceDir = "/opt/cursor/artifacts";
  if (existsSync(evidenceDir)) {
    writeFileSync(
      `${evidenceDir}/drafts-paint.json`,
      JSON.stringify(
        {
          claim: "50-draft list paint median under 100ms, and click-to-visible open under 2x the empty desk open",
          runs: 5,
          interleaved: true,
          emptyOpen,
          fiftyOpen,
          emptyPaint,
          fiftyPaint,
          paintMedian,
          openMedian,
          emptyOpenMedian,
          paintShareOfOpen: openMedian === 0 ? null : paintMedian / openMedian,
        },
        null,
        2,
      ),
    );
  }
  expect(fiftyPaint, `paint samples ${fiftyPaint.join(",")}`).toHaveLength(5);
  expect(paintMedian, `50-draft paint median ${paintMedian} ms`).toBeLessThan(100);
  expect(openMedian, `50-draft open ${openMedian} ms vs empty ${emptyOpenMedian} ms`).toBeLessThan(emptyOpenMedian * 2);
});
