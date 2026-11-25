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
    return response.json() as Promise<{ id: string; status: string; preview: string; events?: unknown[]; draft?: { type?: string; content?: string; proposedFireAt?: number; segments?: { content: string }[] } }[]>;
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
  const ids: string[] = [];
  await page.route("**/api/compose", async (route) => {
    ids.push(JSON.parse(route.request().postData() ?? "{}").id as string);
    await route.abort();
  });
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
  await page.route("**/api/compose", async (route) => {
    ids.push(JSON.parse(route.request().postData() ?? "{}").id as string);
    await route.continue();
  });
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Scheduled locally for")).toBeVisible();
  const rows = await items(page);
  expect(rows).toHaveLength(1);
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  expect(rows[0]?.id).toBe(ids[0]);
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
  await expect(page.getByTestId("schedule-pending")).toHaveText("Scheduling…");
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
  expect(rows[0]?.events).toBeUndefined();
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

test("a schedule that lands after the response was lost is not written again", async ({ page }) => {
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  let payload = "";
  await page.route("**/api/compose", async (route) => {
    payload = route.request().postData() ?? "";
    await route.abort();
  });
  await openCompose(page, signer);
  await page.getByTestId("note-text").fill("Late same note");
  await page.getByTestId("save-draft").click();
  await expect(page.getByTestId("schedule-unknown")).toBeVisible();
  await page.unroute("**/api/compose");
  const stored = await page.evaluate(async (body) => {
    const session = await fetch("/api/session");
    const token = ((await session.json()) as { token: string }).token;
    const response = await fetch("/api/compose", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": token },
      body,
    });
    return response.status;
  }, payload);
  expect(stored).toBe(200);
  let posts = 0;
  await page.route("**/api/compose", async (route) => {
    posts += 1;
    await route.continue();
  });
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Scheduled locally for")).toBeVisible();
  expect(posts).toBe(0);
  const rows = await items(page);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe(JSON.parse(payload).id as string);
});

test("two deliberate copies of the same note stay separate", async ({ page }) => {
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  await openCompose(page, signer);
  await page.getByTestId("note-text").fill("Same words");
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Scheduled locally for")).toBeVisible();
  await page.getByTestId("note-text").fill("Same words");
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Scheduled locally for")).toBeVisible();
  const rows = await items(page);
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  expect(rows.every((row) => row.draft?.content === "Same words" && row.status === "approved")).toBe(true);
});

test("a late copy of an absent attempt does not create a second note", async ({ page }) => {
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  let first = "";
  await page.route("**/api/compose", async (route) => {
    const body = route.request().postData() ?? "";
    if (!first) {
      first = body;
      await route.abort();
      return;
    }
    await route.continue();
  });
  await openCompose(page, signer);
  await page.getByTestId("note-text").fill("Delayed commit note");
  await page.getByTestId("save-draft").click();
  await expect(page.getByTestId("schedule-unknown")).toBeVisible();
  expect(await items(page)).toEqual([]);
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Scheduled locally for")).toBeVisible();
  const stored = await items(page);
  expect(stored).toHaveLength(1);
  const replay = await page.evaluate(async (body) => {
    const session = await fetch("/api/session");
    const token = ((await session.json()) as { token: string }).token;
    const response = await fetch("/api/compose", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": token },
      body,
    });
    return response.status;
  }, first);
  expect(replay).toBe(200);
  const after = await items(page);
  expect(after).toHaveLength(1);
  expect(after[0]?.id).toBe(JSON.parse(first).id as string);
  expect(after[0]?.id).toBe(stored[0]?.id);
});

test("two keyboard retries during a slow queue read send one schedule", async ({ page }) => {
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  await page.route("**/api/compose", (route) => route.abort());
  await openCompose(page, signer);
  await page.getByTestId("note-text").fill("Keyboard once");
  await page.getByTestId("save-draft").click();
  await expect(page.getByTestId("schedule-unknown")).toBeVisible();
  await page.unroute("**/api/compose");
  await page.route("**/api/items**", async (route) => {
    if (route.request().method() === "GET") await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  let posts = 0;
  await page.route("**/api/compose", async (route) => {
    posts += 1;
    await route.continue();
  });
  await page.getByTestId("note-text").focus();
  await page.keyboard.press("Control+Enter");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByText("Scheduled locally for")).toBeVisible();
  expect(posts).toBe(1);
  expect(await items(page)).toHaveLength(1);
});

test("a lost thread response retries the same snapshot once", async ({ page }) => {
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  const ids: string[] = [];
  await page.route("**/api/compose", async (route) => {
    ids.push(JSON.parse(route.request().postData() ?? "{}").id as string);
    await route.fetch();
    await route.fulfill({ status: 200, contentType: "application/json", body: "" });
  });
  await openCompose(page, signer);
  await page.getByTestId("kind-thread").click();
  await page.getByTestId("thread-part").nth(0).fill("Root line");
  await page.getByTestId("thread-part").nth(1).fill("Reply line");
  await page.getByTestId("save-draft").click();
  if ((await page.getByTestId("schedule-unknown").count()) > 0) {
    await page.unroute("**/api/compose");
    await page.route("**/api/compose", async (route) => {
      ids.push(JSON.parse(route.request().postData() ?? "{}").id as string);
      await route.continue();
    });
    await page.getByTestId("save-draft").click();
  }
  await expect(page.getByText("Scheduled locally for")).toBeVisible();
  const rows = await items(page);
  expect(rows).toHaveLength(1);
  expect(new Set(ids).size).toBe(1);
  expect(rows[0]?.draft?.segments?.map((segment) => segment.content)).toEqual(["Root line", "Reply line"]);
});

test("a refused second copy is not reported as the first note", async ({ page }) => {
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  await openCompose(page, signer);
  await page.getByTestId("note-text").fill("Same words");
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Scheduled locally for")).toBeVisible();
  await expect(page.getByText("Scheduled locally for")).toBeHidden();
  await page.route("**/api/compose", (route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "The note could not be saved. Try again." }) }));
  await page.getByTestId("note-text").fill("Same words");
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("The note could not be saved. Try again.")).toBeVisible();
  await expect(page.getByText("Scheduled locally for")).toHaveCount(0);
  await expect(page.getByTestId("schedule-unknown")).toHaveCount(0);
  const rows = await items(page);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.draft?.content).toBe("Same words");
});

test("a successful schedule does not place a check on the reload hint", async ({ page }) => {
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  await openCompose(page, signer);
  await page.getByTestId("note-text").fill("Scheduled without a check");
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Scheduled locally for")).toBeVisible();
  await expect(page.locator(".motion-check")).toHaveCount(0);
  await expect(page.getByTestId("keep-note")).toHaveText("Unsaved text is lost on reload. Save it to keep it in Queue.");
  const rows = await items(page);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("approved");
});
