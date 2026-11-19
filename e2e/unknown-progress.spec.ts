import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Page } from "@playwright/test";
import { suggestionId, unixSeconds } from "../src/domain/brand.ts";
import { noteUnsigned } from "../src/domain/event.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { WorkStore } from "../src/work/store.ts";

const dataDir = "e2e/run";

function profileFile(signer: { npub: string; pubkey: string }) {
  mkdirSync(dataDir, { recursive: true });
  const sqlite = `${dataDir}/app.sqlite`;
  if (existsSync(sqlite)) {
    const db = new DatabaseSync(sqlite, { timeout: 5000 });
    db.exec("DELETE FROM work_items");
    db.close();
  }
  writeFileSync(
    `${dataDir}/profiles.yaml`,
    ["profiles:", "  - id: desk", "    label: Desk", `    npub: ${signer.npub}`, `    pubkey: ${signer.pubkey}`, "    suggester_id: desk-suggester", "    signer:", "      kind: nip07", "    relays: []", "    read_nip65: false", "    allow_public_relays: false", ""].join("\n"),
  );
}

async function rows(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/items?profileId=desk");
    return response.json() as Promise<{ id: string; status: string; events?: { sig?: string }[]; draft?: { content?: string } }[]>;
  });
}

async function lostThenProgress(page: Page, signer: ReturnType<typeof createMockSigner>, sentence: string, next: "signed" | "queued") {
  profileFile(signer);
  await page.goto("/");
  await page.getByTestId("nav-compose").click();
  await page.getByTestId("note-text").fill(sentence);
  let id = "";
  let markFetched: () => void = () => undefined;
  const fetched = new Promise<void>((resolve) => {
    markFetched = resolve;
  });
  let releaseClient: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    releaseClient = resolve;
  });
  await page.route("**/api/compose", async (route) => {
    id = (JSON.parse(route.request().postData() ?? "{}") as { id?: string }).id ?? "";
    await route.fetch();
    markFetched();
    await held;
    await route.fulfill({ status: 200, contentType: "application/json", body: "" });
  });
  const clicked = page.getByTestId("save-draft").click();
  await fetched;
  await progress(id, signer, next);
  releaseClient();
  await clicked;
  await expect(page.getByTestId("schedule-unknown")).toHaveText("This schedule is not confirmed yet. Check the queue, then try again if the note is not there.");
  await expect(page.getByTestId("note-text")).toHaveValue(sentence);
  await expect(page.getByText("Scheduled locally for")).toHaveCount(0);
  await page.unroute("**/api/compose");
  return id;
}

async function progress(id: string, signer: ReturnType<typeof createMockSigner>, next: "signed" | "queued") {
  const store = new WorkStore(`${dataDir}/app.sqlite`);
  const item = store.get(suggestionId(id));
  if (item.status !== "approved" || !("draft" in item) || item.draft.type !== "note") {
    throw new Error(`expected the unsigned approved note, saw ${item.status}`);
  }
  const event = await signer.signEvent(noteUnsigned({ pubkey: signer.pubkey, content: item.draft.content, createdAt: item.draft.proposedFireAt }));
  const at = unixSeconds(Math.floor(Date.now() / 1000));
  const signed = store.transition(item.id, { type: "sign", events: [event] }, at);
  if (signed.status !== "signed") throw new Error("expected a signature");
  expect(signed.events[0]?.sig).toBe(event.sig);
  if (next === "queued") {
    const queued = store.transition(signed.id, { type: "enqueue" }, at);
    expect(queued.status).toBe("queued");
  }
  store.close();
}

async function retryTwice(page: Page, sentence: string, id: string, status: "signed" | "queued") {
  const posts: { id: string; status: number }[] = [];
  await page.route("**/api/compose", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { id?: string };
    const response = await route.fetch();
    posts.push({ id: body.id ?? "", status: response.status() });
    await route.fulfill({ response });
  });
  await page.getByTestId("save-draft").click();
  await expect(page.getByTestId("schedule-unknown")).toBeVisible();
  await expect(page.getByText("already used")).toHaveCount(0);
  await expect(page.getByText("Scheduled locally for")).toHaveCount(0);
  await expect(page.getByTestId("note-text")).toHaveValue(sentence);
  await page.getByTestId("save-draft").click();
  await expect(page.getByTestId("schedule-unknown")).toBeVisible();
  await expect(page.getByText("already used")).toHaveCount(0);
  await expect(page.getByText("Scheduled locally for")).toHaveCount(0);
  await expect(page.getByTestId("note-text")).toHaveValue(sentence);
  const stored = await rows(page);
  expect(posts).toEqual([]);
  expect(stored).toHaveLength(1);
  expect(stored[0]?.id).toBe(id);
  expect(stored[0]?.status).toBe(status);
  expect(stored[0]?.draft).toBeUndefined();
  expect(stored[0]?.events?.length).toBeGreaterThan(0);
  const db = new DatabaseSync(`${dataDir}/app.sqlite`, { readOnly: true, timeout: 5000 });
  const raw = db.prepare("SELECT body_json FROM work_items WHERE id = ?").get(id) as { body_json: string };
  db.close();
  const body = JSON.parse(raw.body_json) as { status: string; draft?: unknown; events?: { sig?: string }[] };
  expect(body.status).toBe(status);
  expect(body.draft).toBeUndefined();
  expect(body.events?.[0]?.sig).toMatch(/^[0-9a-f]{128}$/);
}

for (const next of ["queued", "signed"] as const) {
  test(`an uncertain note that is already ${next} is not scheduled again`, async ({ page }) => {
    const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
    const sentence = `Progress ${next}`;
    const id = await lostThenProgress(page, signer, sentence, next);
    await retryTwice(page, sentence, id, next);
  });
}
