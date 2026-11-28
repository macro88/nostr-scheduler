import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Page } from "@playwright/test";
import { createMockSigner } from "../src/mock-signer/index.ts";

const dataDir = "e2e/run";
const rough = "Sketch";
const dragged = "Writing a full note for the unsigned board now.";
const moved = "Second writing note with enough body to leave rough ideas.";

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

async function seed(page: Page) {
  await page.evaluate(
    async ({ roughNote, draggedNote, movedNote }) => {
      const session = await fetch("/api/session");
      const token = ((await session.json()) as { token: string }).token;
      const when = Math.floor(Date.now() / 1000) + 3600;
      for (const content of [roughNote, draggedNote, movedNote]) {
        const response = await fetch("/api/drafts", {
          method: "POST",
          headers: { "content-type": "application/json", "x-csrf-token": token },
          body: JSON.stringify({ profileId: "desk", draft: { type: "note", content, proposedFireAt: when } }),
        });
        if (!response.ok) throw new Error(await response.text());
      }
    },
    { roughNote: rough, draggedNote: dragged, movedNote: moved },
  );
}

async function items(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/items?profileId=desk");
    return response.json() as Promise<{ id: string; status: string; preview: string }[]>;
  });
}

test("moving a writing note to Ready approves it and does not publish", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    posts.push(new URL(request.url()).pathname);
  });
  openData(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await seed(page);
  await page.getByTestId("nav-board").click();
  await expect(page.getByTestId("column-rough")).toContainText(rough);
  await expect(page.getByTestId("column-writing")).toContainText(dragged);
  await expect(page.getByTestId("column-writing")).toContainText(moved);
  await expect(page.getByTestId("empty-ready")).toHaveText("Nothing here.");
  await expect(page.getByTestId("column-posted")).toHaveCount(0);
  await expect(page.getByTestId("column-rough").getByTestId("move-ready")).toHaveCount(0);
  await expect(page.getByTestId("column-rough").getByTestId("board-drag")).toHaveCount(0);
  const labels = await page.getByTestId("board").getByRole("button").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? node.textContent ?? ""));
  expect(labels.join("\n")).not.toMatch(/\b(discard|publish|sign note)\b/i);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await page.screenshot({ path: "/opt/cursor/artifacts/board-columns.png", fullPage: true });

  const writing = page.getByTestId("column-writing");
  await writing.getByTestId("board-card").filter({ hasText: dragged }).getByTestId("board-drag").dragTo(page.getByTestId("column-ready"));
  await expect(page.getByTestId("column-ready")).toContainText(dragged);
  await writing.getByTestId("board-card").filter({ hasText: moved }).getByTestId("move-ready").click();
  await expect(page.getByTestId("column-ready")).toContainText(moved);
  await expect(page.getByTestId("column-writing").getByTestId("board-card")).toHaveCount(0);
  await expect(page.getByTestId("column-rough")).toContainText(rough);
  await expect(page.getByTestId("column-ready").getByTestId("move-ready")).toHaveCount(0);
  await expect(page.getByTestId("column-ready").getByTestId("board-drag")).toHaveCount(0);
  await page.screenshot({ path: "/opt/cursor/artifacts/board-after-ready.png", fullPage: true });

  const rows = await items(page);
  expect(rows.filter((row) => row.preview === dragged || row.preview === moved).map((row) => row.status).sort()).toEqual(["approved", "approved"]);
  expect(rows.filter((row) => row.preview === rough).map((row) => row.status)).toEqual(["draft"]);
  expect(rows.some((row) => row.status === "sent" || row.status === "queued" || row.status === "signed")).toBe(false);
  expect(posts.filter((path) => path.includes("publish") || path.includes("/sign") || path.endsWith("/discard"))).toEqual([]);
  expect(posts.filter((path) => path.endsWith("/approve"))).toHaveLength(2);

  await page.getByTestId("nav-sign").click();
  await expect(page.getByTestId("sign")).toContainText(dragged);
  await expect(page.getByTestId("sign")).toContainText(moved);
  await expect(page.getByTestId("sign")).not.toContainText(rough);
  await expect(page.getByTestId("sign")).toContainText("2 waiting to be signed");
  await page.screenshot({ path: "/opt/cursor/artifacts/board-sign-list.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("nav-board").click();
  const narrow = await page.evaluate(() => {
    const columns = [...document.querySelectorAll(".board-column")].map((node) => node.getBoundingClientRect());
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      stacked: columns.length === 3 && columns.every((box, index) => index === 0 || box.top >= (columns[index - 1]?.bottom ?? 0) - 1),
    };
  });
  expect(narrow.overflow).toBe(0);
  expect(narrow.stacked).toBe(true);
  for (const name of ["inbox", "compose", "board", "calendar", "log", "sign"]) {
    const box = await page.getByTestId(`nav-${name}`).boundingBox();
    expect(box, name).toBeTruthy();
    if (!box) continue;
    expect(box.x, name).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width, name).toBeLessThanOrEqual(391);
  }
  await page.screenshot({ path: "/opt/cursor/artifacts/board-narrow.png", fullPage: true });
});
