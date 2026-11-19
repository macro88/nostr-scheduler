import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Page } from "@playwright/test";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { LocalRelay } from "../src/test-relay/relay.ts";

const dataDir = "e2e/run";
const example = readFileSync(new URL("../examples/criteria/example-profile.md", import.meta.url), "utf8");

function clearQueue() {
  const sqlite = `${dataDir}/app.sqlite`;
  if (!existsSync(sqlite)) return;
  const db = new DatabaseSync(sqlite);
  db.exec("DELETE FROM work_items");
  db.close();
}

function onSignList(page: Page, text: string) {
  return page.getByTestId("sign").getByRole("article").filter({ hasText: text });
}

function profileFile(signer: { npub: string; pubkey: string }, relay: string) {
  clearQueue();
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

async function items(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/items?profileId=demo");
    return response.json() as Promise<{ id: string; status: string; preview: string }[]>;
  });
}

test("a browser signer that appears after the click can sign", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  profileFile(signer, url);
  await page.exposeFunction("__nostrSign", (event: Parameters<typeof signer.signEvent>[0]) => signer.signEvent(event));
  await page.goto("/");
  const fireAt = Math.floor(Date.now() / 1000) + 180;
  await post(page, "/api/compose", {
    profileId: "demo",
    draft: { type: "note", content: "Delayed signer note", proposedFireAt: fireAt },
  });
  await page.reload();
  await page.getByTestId("nav-sign").click();
  await expect(onSignList(page, "Delayed signer note")).toBeVisible();
  await page.getByTestId("sign-browser").click();
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const target = window as Window & {
      nostr?: { signEvent: (event: unknown) => Promise<unknown>; getPublicKey: () => Promise<string> };
      __nostrSign?: (event: unknown) => Promise<unknown>;
      __publicKeyReads?: number;
      __signCalls?: number;
    };
    target.__publicKeyReads = 0;
    target.__signCalls = 0;
    target.nostr = {
      getPublicKey() {
        target.__publicKeyReads = (target.__publicKeyReads ?? 0) + 1;
        return Promise.resolve("ab".repeat(32));
      },
      signEvent(event) {
        target.__signCalls = (target.__signCalls ?? 0) + 1;
        if (!target.__nostrSign) throw new Error("missing signer");
        return target.__nostrSign(event);
      },
    };
  });
  await expect(page.getByTestId("sign-status")).toContainText("Queued");
  const reads = await page.evaluate(() => (window as Window & { __publicKeyReads?: number; __signCalls?: number }).__publicKeyReads);
  const calls = await page.evaluate(() => (window as Window & { __signCalls?: number }).__signCalls);
  expect(reads).toBe(0);
  expect(calls).toBe(1);
  const queued = (await items(page)).find((item) => item.preview.includes("Delayed signer note"));
  expect(queued?.status).toBe("queued");
  await relay.stop();
});

test("one click opens one prompt when the button is clicked twice", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  profileFile(signer, url);
  await page.exposeFunction("__nostrSign", (event: Parameters<typeof signer.signEvent>[0]) => signer.signEvent(event));
  await page.goto("/");
  const fireAt = Math.floor(Date.now() / 1000) + 180;
  await post(page, "/api/compose", {
    profileId: "demo",
    draft: { type: "note", content: "One prompt note", proposedFireAt: fireAt },
  });
  await page.reload();
  await page.getByTestId("nav-sign").click();
  await expect(onSignList(page, "One prompt note")).toBeVisible();
  await page.evaluate(() => {
    const target = window as Window & {
      nostr?: { signEvent: (event: unknown) => Promise<unknown> };
      __nostrSign?: (event: unknown) => Promise<unknown>;
      __signCalls?: number;
    };
    target.__signCalls = 0;
    target.nostr = {
      signEvent(event) {
        target.__signCalls = (target.__signCalls ?? 0) + 1;
        if (!target.__nostrSign) throw new Error("missing signer");
        return target.__nostrSign(event);
      },
    };
  });
  await page.getByTestId("sign-browser").evaluate((button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect(page.getByTestId("sign-status")).toContainText("Queued");
  expect(await page.evaluate(() => (window as Window & { __signCalls?: number }).__signCalls)).toBe(1);
  await relay.stop();
});

test("a missing signer is reported only after the click has waited", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  profileFile(signer, url);
  await page.goto("/");
  const fireAt = Math.floor(Date.now() / 1000) + 180;
  await post(page, "/api/compose", {
    profileId: "demo",
    draft: { type: "note", content: "Missing signer note", proposedFireAt: fireAt },
  });
  await page.reload();
  await page.getByTestId("nav-sign").click();
  await expect(onSignList(page, "Missing signer note")).toBeVisible();
  const started = Date.now();
  await page.getByTestId("sign-browser").click();
  await expect(page.getByTestId("sign-status")).toContainText("A browser extension that only runs on HTTPS will not appear here.");
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  const note = (await items(page)).find((item) => item.preview.includes("Missing signer note"));
  expect(note?.status).toBe("approved");
  await relay.stop();
});

test("an object without signEvent is not treated as a missing extension", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  profileFile(signer, url);
  await page.addInitScript(() => {
    (window as Window & { nostr?: { ready: boolean } }).nostr = { ready: true };
  });
  await page.goto("/");
  const fireAt = Math.floor(Date.now() / 1000) + 180;
  await post(page, "/api/compose", {
    profileId: "demo",
    draft: { type: "note", content: "Incompatible signer note", proposedFireAt: fireAt },
  });
  await page.reload();
  await page.getByTestId("nav-sign").click();
  await expect(onSignList(page, "Incompatible signer note")).toBeVisible();
  await page.getByTestId("sign-browser").click();
  await expect(page.getByTestId("sign-status")).toContainText("cannot sign notes");
  const note = (await items(page)).find((item) => item.preview.includes("Incompatible signer note"));
  expect(note?.status).toBe("approved");
  await relay.stop();
});

test("a refused signature is not described as a missing extension", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  profileFile(signer, url);
  await page.addInitScript(() => {
    (window as Window & { nostr?: { signEvent: (event: unknown) => Promise<unknown> } }).nostr = {
      signEvent: () => Promise.reject(new Error("User rejected the request")),
    };
  });
  await page.goto("/");
  const fireAt = Math.floor(Date.now() / 1000) + 180;
  await post(page, "/api/compose", {
    profileId: "demo",
    draft: { type: "note", content: "Refused signer note", proposedFireAt: fireAt },
  });
  await page.reload();
  await page.getByTestId("nav-sign").click();
  await expect(onSignList(page, "Refused signer note")).toBeVisible();
  await page.getByTestId("sign-browser").click();
  await expect(page.getByTestId("sign-status")).toContainText("did not allow this note");
  await expect(page.getByTestId("sign-status")).not.toContainText("install a signer");
  const note = (await items(page)).find((item) => item.preview.includes("Refused signer note"));
  expect(note?.status).toBe("approved");
  await relay.stop();
});

test("leaving Sign drops a signature that arrives later", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  profileFile(signer, url);
  await page.exposeFunction("__nostrSign", (event: Parameters<typeof signer.signEvent>[0]) => signer.signEvent(event));
  await page.goto("/");
  const fireAt = Math.floor(Date.now() / 1000) + 180;
  await post(page, "/api/compose", {
    profileId: "demo",
    draft: { type: "note", content: "Left before sign", proposedFireAt: fireAt },
  });
  await page.reload();
  await page.getByTestId("nav-sign").click();
  await expect(onSignList(page, "Left before sign")).toBeVisible();
  await page.evaluate(() => {
    const target = window as Window & {
      nostr?: { signEvent: (event: unknown) => Promise<unknown> };
      __nostrSign?: (event: unknown) => Promise<unknown>;
      __release?: () => void;
    };
    target.nostr = {
      signEvent(event) {
        return new Promise((resolve, reject) => {
          target.__release = () => {
            if (!target.__nostrSign) {
              reject(new Error("missing signer"));
              return;
            }
            void target.__nostrSign(event).then(resolve, reject);
          };
        });
      },
    };
  });
  await page.getByTestId("sign-browser").click();
  await expect(page.getByTestId("sign-status")).toContainText("Waiting for the signer");
  await page.getByTestId("nav-calendar").click();
  await page.evaluate(() => (window as Window & { __release?: () => void }).__release?.());
  await page.waitForTimeout(300);
  const note = (await items(page)).find((item) => item.preview.includes("Left before sign"));
  expect(note?.status).toBe("approved");
  await relay.stop();
});

test("a signature from another pubkey is not submitted", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  profileFile(signer, url);
  await page.addInitScript(() => {
    (window as Window & { nostr?: { signEvent: (event: unknown) => Promise<unknown> } }).nostr = {
      signEvent: (event) => Promise.resolve({ ...(event as object), pubkey: "ab".repeat(32) }),
    };
  });
  await page.goto("/");
  const fireAt = Math.floor(Date.now() / 1000) + 180;
  await post(page, "/api/compose", {
    profileId: "demo",
    draft: { type: "note", content: "Other identity note", proposedFireAt: fireAt },
  });
  await page.reload();
  await page.getByTestId("nav-sign").click();
  await expect(onSignList(page, "Other identity note")).toBeVisible();
  await page.getByTestId("sign-browser").click();
  await expect(page.getByTestId("sign-status")).toContainText("different identity");
  const note = (await items(page)).find((item) => item.preview.includes("Other identity note"));
  expect(note?.status).toBe("approved");
  await relay.stop();
});
