import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Page } from "@playwright/test";
import { createMockSigner } from "../src/mock-signer/index.ts";

const dataDir = "e2e/run";

function profileFile(signer: { npub: string; pubkey: string }) {
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

async function items(page: Page, profileId = "desk") {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/items?profileId=${id}`);
    return response.json() as Promise<{ id: string; status: string; preview: string; draft?: { content?: string; proposedFireAt?: number } }[]>;
  }, profileId);
}

async function openCompose(page: Page, signer: { npub: string; pubkey: string }) {
  profileFile(signer);
  await page.goto("/");
  await page.getByTestId("nav-compose").click();
  await expect(page.getByTestId("note-text")).toBeVisible();
}

test("a refused schedule leaves no approved row and keeps the note", async ({ page }) => {
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  await page.route("**/api/compose", (route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "The note could not be saved. Try again." }) }));
  await openCompose(page, signer);
  const sentence = "Confirmed no write";
  await page.getByTestId("note-text").fill(sentence);
  const when = await page.getByTestId("schedule").innerText();
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("The note could not be saved. Try again.")).toBeVisible();
  await expect(page.getByTestId("schedule-unknown")).toHaveCount(0);
  await expect(page.getByTestId("note-text")).toHaveValue(sentence);
  await expect(page.getByTestId("schedule")).toHaveText(when);
  expect(await items(page)).toEqual([]);
});

test("a lost response stays unconfirmed until a later check sees no row", async ({ page }) => {
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  await page.route("**/api/compose", (route) => route.abort());
  await openCompose(page, signer);
  const sentence = "Lost response note";
  await page.getByTestId("note-text").fill(sentence);
  const when = await page.getByTestId("schedule").innerText();
  await page.getByTestId("save-draft").click();
  await expect(page.getByTestId("schedule-unknown")).toHaveText("This schedule is not confirmed yet. Check the queue, then try again if the note is not there.");
  await expect(page.getByText("The note could not be saved. Try again.")).toHaveCount(0);
  await expect(page.getByTestId("note-text")).toHaveValue(sentence);
  await expect(page.getByTestId("schedule")).toHaveText(when);
  expect(await items(page)).toEqual([]);
  await page.unroute("**/api/compose");
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Scheduled locally for")).toBeVisible();
  const rows = await items(page);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "approved", preview: sentence });
  await expect(page.getByTestId("schedule-unknown")).toHaveCount(0);
});

test("a slow success stays pending and then shows one unsigned note", async ({ page }) => {
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  await page.route("**/api/compose", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 6000));
    await route.continue();
  });
  await openCompose(page, signer);
  const sentence = "Slow success note";
  await page.getByTestId("note-text").fill(sentence);
  const when = await page.getByTestId("schedule").innerText();
  await page.getByTestId("save-draft").click();
  await page.waitForTimeout(4000);
  await expect(page.getByTestId("schedule-unknown")).toHaveCount(0);
  await expect(page.getByText("Scheduled locally for")).toHaveCount(0);
  await expect(page.getByTestId("note-text")).toHaveValue(sentence);
  await expect(page.getByTestId("schedule")).toHaveText(when);
  await expect(page.getByTestId("save-draft")).toBeDisabled();
  await expect(page.getByText("Scheduled locally for")).toBeVisible({ timeout: 8000 });
  const rows = await items(page);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("approved");
  expect(rows[0]?.draft?.content).toBe(sentence);
  await expect(page.getByTestId("status-approved")).toHaveText("Awaiting signature");
});

test("a late result does not clear a newer edit", async ({ page }) => {
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  await page.route("**/api/compose", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await route.continue();
  });
  await openCompose(page, signer);
  const sentence = "Original sentence";
  await page.getByTestId("note-text").fill(sentence);
  await page.getByTestId("save-draft").click();
  await page.getByTestId("nav-sign").click();
  await page.getByTestId("nav-compose").click();
  await page.getByTestId("note-text").fill(`${sentence} plus`);
  await page.waitForTimeout(2500);
  await expect(page.getByText("Scheduled locally for")).toHaveCount(0);
  await expect(page.getByTestId("note-text")).toHaveValue(`${sentence} plus`);
  const rows = await items(page);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.draft?.content).toBe(sentence);
  expect(rows[0]?.status).toBe("approved");
});

test("a stored note with a dropped response is reconciled without a second write", async ({ page }) => {
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  let posts = 0;
  await page.route("**/api/compose", async (route) => {
    posts += 1;
    await route.fetch();
    await route.fulfill({ status: 200, contentType: "application/json", body: "" });
  });
  await openCompose(page, signer);
  const sentence = "Dropped after store";
  await page.getByTestId("note-text").fill(sentence);
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Scheduled locally for")).toBeVisible();
  const rows = await items(page);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "approved" });
  expect(rows[0]?.draft?.content).toBe(sentence);
  expect(posts).toBe(1);
});

test("a late result does not clear an edit on another profile", async ({ page }) => {
  const desk = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  const other = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
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
      `    npub: ${desk.npub}`,
      `    pubkey: ${desk.pubkey}`,
      "    suggester_id: desk-suggester",
      "    signer:",
      "      kind: nip07",
      "    relays: []",
      "    read_nip65: false",
      "    allow_public_relays: false",
      "  - id: other",
      "    label: Other",
      `    npub: ${other.npub}`,
      `    pubkey: ${other.pubkey}`,
      "    suggester_id: other-suggester",
      "    signer:",
      "      kind: nip07",
      "    relays: []",
      "    read_nip65: false",
      "    allow_public_relays: false",
      "",
    ].join("\n"),
  );
  await page.route("**/api/compose", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  });
  await page.goto("/");
  await page.getByTestId("nav-compose").click();
  await page.getByTestId("note-text").fill("Desk sentence");
  await page.getByTestId("save-draft").click();
  await page.getByTestId("profile").click();
  await page.getByRole("radio", { name: /^Other/ }).click();
  await expect(page.getByTestId("profile")).toHaveText("Other");
  await page.getByTestId("note-text").fill("Other sentence");
  await page.waitForTimeout(3000);
  await expect(page.getByText("Scheduled locally for")).toHaveCount(0);
  await expect(page.getByTestId("note-text")).toHaveValue("Other sentence");
  const deskRows = await items(page, "desk");
  expect(deskRows).toHaveLength(1);
  expect(deskRows[0]?.draft?.content).toBe("Desk sentence");
  expect(await items(page, "other")).toEqual([]);
});
