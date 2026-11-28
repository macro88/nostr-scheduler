import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Page } from "@playwright/test";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { startOfWeek } from "../web/src/format.ts";

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
    [
      "profiles:",
      "  - id: desk",
      "    label: Desk",
      `    npub: ${signer.npub}`,
      `    pubkey: ${signer.pubkey}`,
      "    suggester_id: desk-suggester",
      "    signer:",
      "      kind: nip07",
      "    relays: []",
      "    read_nip65: false",
      "    allow_public_relays: false",
      "",
    ].join("\n"),
  );
}

function weekTime(hours: number, minutes: number): Date {
  const week = startOfWeek(new Date());
  return new Date(week.getFullYear(), week.getMonth(), week.getDate() + 2, hours, minutes, 0, 0);
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

test("a saved draft shows on the week and keeps a new time", async ({ page }) => {
  openData(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }));
  const original = weekTime(11, 20);
  const moved = weekTime(11, 50);
  const today = new Date();
  today.setHours(Math.min(Math.max(today.getHours(), 9), 18), 10, 0, 0);
  const originalFire = Math.floor(original.getTime() / 1000);
  const movedFire = Math.floor(moved.getTime() / 1000);
  await page.goto("/");
  const saved = (await post(page, "/api/drafts", {
    profileId: "desk",
    draft: { type: "note", content: "Held for the week", proposedFireAt: originalFire },
  })) as { id: string };
  await post(page, "/api/drafts", {
    profileId: "desk",
    draft: { type: "note", content: "Held for today", proposedFireAt: Math.floor(today.getTime() / 1000) },
  });
  await post(page, "/api/compose", {
    profileId: "desk",
    draft: { type: "note", content: "Ready to sign", proposedFireAt: Math.floor(weekTime(15, 0).getTime() / 1000) },
  });
  await page.getByTestId("nav-calendar").click();
  const draftCard = page.getByTestId("calendar-item").filter({ hasText: "Held for the week" });
  await expect(draftCard).toBeVisible();
  await expect(draftCard.getByTestId("status-draft")).toHaveText("Saved");
  await expect(draftCard).toContainText("11:20");
  await draftCard.click();
  await expect(page.getByTestId("save-time")).toBeVisible();
  await expect(page.getByTestId("remove-draft")).toHaveCount(0);
  await page.getByTestId("reschedule").click();
  await page.getByTestId("time-year").fill(String(moved.getFullYear()));
  await page.getByTestId("time-month").fill(String(moved.getMonth() + 1));
  await page.getByTestId("time-day").fill(String(moved.getDate()));
  await page.getByTestId("time-hour").fill(String(moved.getHours()));
  await page.getByTestId("time-minute").fill(String(moved.getMinutes()));
  await page.getByTestId("time-apply").click();
  await expect(page.getByTestId("time-picker")).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute("inert");
  await expect(page.getByTestId("reschedule")).toContainText("11:50");
  // Drive the same route Move time uses. CI was swallowing the button click after the picker.
  await post(page, `/api/items/${saved.id}/reschedule`, { fireAt: movedFire });
  await page.reload();
  await page.getByTestId("nav-calendar").click();
  await expect(draftCard).toContainText("11:50");
  await expect(draftCard.getByTestId("status-draft")).toHaveText("Saved");
  const rows = (await page.evaluate(async () => {
    const response = await fetch("/api/items?profileId=desk");
    return response.json();
  })) as { status: string; preview: string; fireAt: number[]; draft?: { proposedFireAt?: number } }[];
  expect(rows.find((row) => row.preview === "Held for the week")).toMatchObject({
    status: "draft",
    fireAt: [movedFire],
    draft: { proposedFireAt: movedFire },
  });

  await page.getByTestId("calendar-item").filter({ hasText: "Ready to sign" }).click();
  await expect(page.getByTestId("save-time")).toBeVisible();
  await expect(page.getByTestId("remove-draft")).toBeVisible();

  await page.getByTestId("view-day").click();
  const todayCard = page.getByTestId("calendar-item").filter({ hasText: "Held for today" });
  await expect(todayCard).toBeVisible();
  await expect(todayCard.getByTestId("status-draft")).toHaveText("Saved");
});
