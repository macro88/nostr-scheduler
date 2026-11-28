import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { LocalRelay } from "../src/test-relay/relay.ts";
import { ResearchStore } from "../src/research/store.ts";

const dataDir = fileURLToPath(new URL("./run", import.meta.url));
const example = readFileSync(new URL("../examples/criteria/example-profile.md", import.meta.url), "utf8");
const pubkey = "ab".repeat(32);
const eventId = "cd".repeat(32);
const createdAt = 1_700_000_000;

function resetRows() {
  mkdirSync(dataDir, { recursive: true });
  const research = new ResearchStore(`${dataDir}/research.sqlite`);
  research.close();
  for (const name of ["app.sqlite", "research.sqlite"]) {
    const path = `${dataDir}/${name}`;
    if (!existsSync(path)) continue;
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout = 3000");
    if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_items'").get()) {
      db.exec("DELETE FROM work_items");
    }
    if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'research_records'").get()) {
      db.exec("DELETE FROM research_records");
    }
    db.close();
  }
}

function writeProfile(signer: { npub: string; pubkey: string }, relay: string) {
  mkdirSync(`${dataDir}/criteria`, { recursive: true });
  writeFileSync(`${dataDir}/criteria/remix.md`, example.replace("profile_id: example", "profile_id: remix"));
  writeFileSync(
    `${dataDir}/profiles.yaml`,
    [
      "profiles:",
      "  - id: remix",
      "    label: Remix",
      `    npub: ${signer.npub}`,
      `    pubkey: ${signer.pubkey}`,
      "    suggester_id: remix-suggester",
      "    signer:",
      "      kind: nip07",
      "    relays:",
      `      - ${relay}`,
      "    read_nip65: false",
      "    allow_public_relays: false",
      "    criteria_path: criteria/remix.md",
      "",
    ].join("\n"),
  );
}

function outlier(content: string) {
  return {
    kind: "outlier",
    id: "res_out01",
    profileId: "remix",
    authorPubkey: pubkey,
    eventId,
    content,
    multiplier: 4,
    baseline: 1,
    signals: { replies: 8, reposts: 2, reactions: 20, zaps: 1 },
    createdAt,
    scannedAt: createdAt + 30,
  };
}

function source(id: string, content: string) {
  return {
    kind: "source",
    id,
    profileId: "remix",
    authorPubkey: pubkey,
    eventId,
    content,
    createdAt,
  };
}

async function installSigner(page: Page, signer: ReturnType<typeof createMockSigner>) {
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
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "request failed");
      return body;
    },
    { path, payload },
  );
}

test.use({ viewport: { width: 1280, height: 800 }, video: "on" });

test("remix an outlier into a draft, then schedule and sign without publishing", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  writeProfile(signer, url);
  resetRows();
  const research = new ResearchStore(`${dataDir}/research.sqlite`);
  research.insertFixture(outlier("A hot public note"));
  research.close();
  await installSigner(page, signer);
  await page.goto("/");
  await page.getByTestId("nav-research").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Remix");
  await page.getByTestId("research-row").click();
  const sourceNode = page.getByTestId("source-text");
  await expect(sourceNode).toHaveText("A hot public note");
  expect(await sourceNode.evaluate((node) => node.tagName)).toBe("PRE");
  expect(await sourceNode.evaluate((node) => node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement || (node instanceof HTMLElement && node.isContentEditable))).toBe(false);
  await expect(page.getByTestId("remix-text")).toHaveValue("A hot public note");
  await page.getByTestId("remix-text").fill("A hot public note, in my voice");
  await expect(sourceNode).toHaveText("A hot public note");
  await expect(page.getByTestId("preview-line")).toHaveText("A hot public note, in my voice");
  await expect(page.getByTestId("remix").getByRole("button", { name: "Schedule" })).toHaveCount(0);
  await expect(page.getByTestId("remix").getByRole("button", { name: /publish/i })).toHaveCount(0);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByTestId("copy-remix").click();
  await expect(page.getByTestId("copy-status")).toHaveText(/Copied/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("A hot public note, in my voice");
  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  await page.screenshot({ path: "/opt/cursor/artifacts/remix-source-and-editor.png", animations: "disabled" });
  await page.getByTestId("save-remix").click();
  await expect(page.getByText("Saved to drafts.")).toBeVisible();

  const saved = await page.evaluate(async () => {
    const items = (await fetch("/api/items?profileId=remix").then((response) => response.json())) as {
      id: string;
      status: string;
      origin: string;
      preview: string;
    }[];
    const notes = (await fetch("/api/research?profileId=remix").then((response) => response.json())) as {
      id: string;
      kind: string;
      content: string;
      remixedAt?: number;
    }[];
    return { items, notes };
  });
  expect(saved.items.map((item) => ({ status: item.status, origin: item.origin, preview: item.preview }))).toEqual([
    { status: "draft", origin: "manual", preview: "A hot public note, in my voice" },
  ]);
  expect(saved.notes).toEqual([
    expect.objectContaining({ id: "res_out01", kind: "outlier", content: "A hot public note", remixedAt: expect.any(Number) }),
  ]);
  expect(saved.items.some((item) => item.status === "queued" || item.status === "sent")).toBe(false);

  await page.getByTestId("edit-in-compose").click();
  await expect(page.getByTestId("draft-row")).toContainText("A hot public note, in my voice");
  await page.getByTestId("draft-row").click();
  await expect(page.getByTestId("note-text")).toHaveValue("A hot public note, in my voice");
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Scheduled locally for")).toBeVisible();
  await page.getByTestId("nav-sign").click();
  await page.getByTestId("sign-browser").click();
  await expect(page.getByTestId("sign-status")).toContainText("Queued");
  const published = (await post(page, "/api/publish", {})) as { sent?: number; waiting?: number };
  expect(published).toMatchObject({ sent: 0, waiting: 1 });
  const after = await page.evaluate(async () => {
    const items = (await fetch("/api/items?profileId=remix").then((response) => response.json())) as { status: string; preview: string }[];
    return items.find((item) => item.preview === "A hot public note, in my voice") ?? null;
  });
  expect(after).toMatchObject({ status: "queued" });
  expect(relay.storedIds()).toEqual([]);
  await page.getByTestId("nav-compose").click();
  await expect(page.getByTestId("draft-row")).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Upcoming" })).toContainText("A hot public note, in my voice");
  await page.screenshot({ path: "/opt/cursor/artifacts/remix-queued-not-sent.png", animations: "disabled" });
  await relay.stop();
});

test("a cached source paints in the remix view inside the open budget", async ({ page }) => {
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  writeProfile(signer, "ws://127.0.0.1:9");
  resetRows();
  const research = new ResearchStore(`${dataDir}/research.sqlite`);
  research.insertFixture(source("res_src01", "Cached source one"));
  research.insertFixture(source("res_src02", "Cached source two"));
  research.close();
  await page.goto("/");
  await page.getByTestId("nav-research").click();
  await expect(page.getByTestId("research-row")).toHaveCount(2);
  const samples: { paint: number; text: string }[] = [];
  for (let index = 0; index < 5; index += 1) {
    const id = index % 2 === 0 ? "res_src01" : "res_src02";
    const expected = id === "res_src01" ? "Cached source one" : "Cached source two";
    await page.evaluate(() => {
      performance.clearMarks("remix-open-start");
      performance.clearMarks("remix-open-paint");
      performance.clearMeasures("remix-open");
      const source = document.querySelector("[data-testid='source-text']");
      if (source instanceof HTMLElement) delete source.dataset.openMs;
    });
    await page.locator(`[data-testid="research-row"][data-research-id="${id}"]`).click();
    await expect(page.getByTestId("source-text")).toHaveText(expected);
    const paint = await page.getByTestId("source-text").evaluate((node) => {
      const measured = node instanceof HTMLElement ? Number(node.dataset.openMs) : Number.NaN;
      return { paint: measured, text: node.textContent ?? "" };
    });
    expect(paint.text).toBe(expected);
    expect(Number.isFinite(paint.paint), "the open clock did not run").toBe(true);
    samples.push(paint);
  }
  const paints = samples.map((sample) => sample.paint);
  const ordered = [...paints].sort((left, right) => left - right);
  const median = ordered[2] ?? 0;
  const evidence = {
    claim: "Selecting a cached source post paints its read-only text in under 100 ms. Fail above 300 ms.",
    clock: "click handler to the layout effect that finds the source text",
    excludes: "the HTTP list, which has already rendered both rows",
    runs: paints,
    median,
    min: ordered[0] ?? 0,
    max: ordered[4] ?? 0,
    texts: samples.map((sample) => sample.text),
  };
  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  writeFileSync("/opt/cursor/artifacts/remix-open.json", JSON.stringify(evidence, null, 2));
  expect(median, `cached source open median ${median} ms`).toBeLessThan(100);
  expect(evidence.max, `cached source open max ${evidence.max} ms`).toBeLessThan(300);
});
