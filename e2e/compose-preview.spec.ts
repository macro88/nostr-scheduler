import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Page } from "@playwright/test";
import { createMockSigner } from "../src/mock-signer/index.ts";

const dataDir = "e2e/run";
const note = "A live preview of the note on the desk.";

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

async function openCompose(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await page.getByTestId("nav-compose").click();
  await expect(page.getByTestId("drafts-empty")).toHaveText("No saved drafts.");
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

test("typing updates the preview, and schedule clears it with the editor", async ({ page }) => {
  openData(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }));
  await openCompose(page, 1280, 800);

  await page.getByTestId("note-text").fill(note);
  await expect(page.getByTestId("preview-line")).toHaveText(note);
  const beside = await page.evaluate(() => {
    const editor = document.querySelector("[data-testid='note-text']");
    const preview = document.querySelector("[data-testid='compose-preview']");
    const foot = document.querySelector(".composer-foot");
    if (!(editor instanceof HTMLElement) || !(preview instanceof HTMLElement) || !(foot instanceof HTMLElement)) return null;
    const editorBox = editor.getBoundingClientRect();
    const previewBox = preview.getBoundingClientRect();
    const footBox = foot.getBoundingClientRect();
    return {
      previewLeft: previewBox.left,
      editorRight: editorBox.right,
      previewTop: previewBox.top,
      editorTop: editorBox.top,
      editorWidth: editor.offsetWidth,
      footBottom: footBox.bottom,
      innerHeight: window.innerHeight,
      horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(beside).not.toBeNull();
  expect(beside?.editorWidth).toBe(720);
  expect(beside?.previewLeft ?? 0).toBeGreaterThanOrEqual((beside?.editorRight ?? 0) - 1);
  expect(Math.abs((beside?.previewTop ?? 0) - (beside?.editorTop ?? 0))).toBeLessThanOrEqual(8);
  expect(beside?.footBottom ?? 9999).toBeLessThanOrEqual(beside?.innerHeight ?? 0);
  expect(beside?.horizontal).toBe(0);
  await expect(page.getByRole("complementary", { name: "Upcoming" })).toBeVisible();
  await expect(page.getByTestId("drafts-desk")).toBeVisible();

  await page.getByTestId("kind-thread").click();
  await page.getByTestId("thread-part").nth(0).fill("Root line");
  await page.getByTestId("thread-part").nth(1).fill("Next line");
  await expect(page.getByTestId("preview-line")).toHaveText(["Root line", "Next line"]);

  await page.getByTestId("kind-reply").click();
  await page.getByTestId("reply-text").fill("Thanks for the note");
  await expect(page.getByTestId("preview-line")).toHaveText("Thanks for the note");

  await page.setViewportSize({ width: 390, height: 844 });
  const stacked = await page.evaluate(() => {
    const editor = document.querySelector("[data-testid='reply-text']");
    const preview = document.querySelector("[data-testid='compose-preview']");
    if (!(editor instanceof HTMLElement) || !(preview instanceof HTMLElement)) return null;
    const editorBox = editor.getBoundingClientRect();
    const previewBox = preview.getBoundingClientRect();
    return {
      previewTop: previewBox.top,
      editorBottom: editorBox.bottom,
      horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(stacked?.previewTop ?? 0).toBeGreaterThanOrEqual((stacked?.editorBottom ?? 0) - 1);
  expect(stacked?.horizontal).toBe(0);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("kind-note").click();
  await expect(page.getByTestId("note-text")).toHaveValue(note);
  await expect(page.getByTestId("preview-line")).toHaveText(note);
  await page.getByTestId("save-note").click();
  await expect(page.getByTestId("draft-row")).toContainText(note);
  await expect(page.getByTestId("note-text")).toHaveValue(note);
  await expect(page.getByTestId("preview-line")).toHaveText(note);

  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Scheduled locally for")).toBeVisible();
  await expect(page.getByTestId("note-text")).toHaveValue("");
  await expect(page.getByTestId("preview-line")).toHaveCount(0);
  await expect(page.getByTestId("draft-row")).toHaveCount(0);
});

test("a 280-character note reaches the preview inside the desk budget", async ({ page }) => {
  openData(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }));
  await openCompose(page, 1280, 800);
  const typed = "The desk preview should keep up with a note as the operator types it. ".repeat(20).slice(0, 280);
  expect(typed).toHaveLength(280);
  await page.getByTestId("note-text").fill("warmup");
  await expect(page.getByTestId("preview-line")).toHaveText("warmup");

  const samples = await page.evaluate(async (value) => {
    const editor = document.querySelector("[data-testid='note-text']");
    if (!(editor instanceof HTMLTextAreaElement)) return [];
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) return [];
    const runs: { commitMs: number; paintMs: number; matched: boolean }[] = [];
    for (let run = 0; run < 9; run += 1) {
      setter.call(editor, "");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const started = performance.now();
      setter.call(editor, value);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      const committed = performance.now();
      const line = document.querySelector("[data-testid='preview-line']");
      const matched = line?.textContent === value && editor.value === value;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      runs.push({ commitMs: committed - started, paintMs: performance.now() - started, matched });
    }
    return runs;
  }, typed);

  expect(samples).toHaveLength(9);
  expect(samples.every((sample) => sample.matched)).toBe(true);
  const commit = samples.map((sample) => sample.commitMs);
  const paint = samples.map((sample) => sample.paintMs);
  const commitMedian = median(commit);
  const paintMedian = median(paint);
  const evidenceDir = "/opt/cursor/artifacts";
  if (existsSync(evidenceDir)) {
    writeFileSync(
      `${evidenceDir}/compose-preview-timing.json`,
      JSON.stringify(
        {
          claim: "input event to preview text for a 280-character note stays under 150ms median",
          runs: 9,
          commit,
          paint,
          commitMedian,
          paintMedian,
          commitMin: Math.min(...commit),
          commitMax: Math.max(...commit),
          paintMin: Math.min(...paint),
          paintMax: Math.max(...paint),
          matched: samples.every((sample) => sample.matched),
        },
        null,
        2,
      ),
    );
  }
  expect(paintMedian, `paint median ${paintMedian} ms, commits ${commit.join(",")}`).toBeLessThan(150);
});
