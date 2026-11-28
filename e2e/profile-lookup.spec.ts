import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { relayUrl, unixSeconds } from "../src/domain/brand.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { publishToRelay } from "../src/test-relay/client.ts";
import { LocalRelay } from "../src/test-relay/relay.ts";
import { shortNpub } from "../web/src/npub.ts";

const mode = { NOSTR_SCHEDULER_MODE: "test" };
const createdAt = 1_700_000_000;
const secret = "nsec1notarealkeyxxxxxxxx";

function startUi(dataDir: string): Promise<ChildProcess> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, ["src/http/serve.ts"], {
    cwd: root,
    env: {
      ...process.env,
      NOSTR_SCHEDULER_MODE: "test",
      NOSTR_SCHEDULER_DATA: dataDir,
      PORT: "4176",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    output += chunk;
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output || "ui did not start")), 20_000);
    const ready = () => {
      if (!output.includes("ui http://127.0.0.1:4176")) return;
      clearTimeout(timer);
      resolve(child);
    };
    child.stdout?.on("data", ready);
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(output || "ui exited"));
    });
  });
}

test("looks up a public npub and does not queue a post", async ({ page }) => {
  test.setTimeout(60_000);
  const relay = new LocalRelay();
  const url = await relay.start();
  const dir = mkdtempSync(join(tmpdir(), "profile-lookup-ui-"));
  const operator = createMockSigner(mode);
  const author = createMockSigner(mode);
  const other = createMockSigner(mode);
  writeFileSync(
    join(dir, "profiles.yaml"),
    [
      "profiles:",
      "  - id: demo",
      "    label: Demo",
      `    npub: ${operator.npub}`,
      `    pubkey: ${operator.pubkey}`,
      "    suggester_id: demo-suggester",
      "    signer:",
      "      kind: mock",
      "    relays:",
      `      - ${url}`,
      "    read_nip65: false",
      "",
    ].join("\n"),
  );
  const at = (offset: number) => unixSeconds(createdAt + offset);
  const note = author.signFixture({ kind: 1, created_at: at(0), tags: [], content: "Bitcoin and lightning keep the lights on" });
  const events = [
    author.signFixture({
      kind: 0,
      created_at: at(-10),
      tags: [],
      content: JSON.stringify({ name: "ada", display_name: "Ada Lovelace", about: "Public notes about relays." }),
    }),
    note,
    author.signFixture({ kind: 1, created_at: at(86_400), tags: [], content: "Bitcoin fees fell again today" }),
    author.signFixture({
      kind: 1,
      created_at: at(172_800),
      tags: [["e", note.id, "", "reply"]],
      content: "Lightning channels opened overnight",
    }),
    author.signFixture({ kind: 1, created_at: at(259_200), tags: [["q", note.id]], content: "A quoted bitcoin thread" }),
    author.signFixture({
      kind: 6,
      created_at: at(345_600),
      tags: [["e", note.id]],
      content: "bitcoin should not pillar from a repost",
    }),
    other.signFixture({ kind: 1, created_at: at(10), tags: [], content: "not on the list" }),
  ];
  for (const event of events) {
    const result = await publishToRelay(relayUrl(url), event);
    expect(result.accepted).toBe(true);
  }
  const before = relay.storedIds().slice().sort();
  const child = await startUi(dir);
  const posts: string[] = [];
  const lookups: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
    if (request.url().includes("/api/profile-lookup")) lookups.push(request.url());
  });
  try {
    await page.goto("http://127.0.0.1:4176/");
    await page.getByTestId("nav-lookup").click();
    await expect(page.getByRole("heading", { name: "Lookup" })).toBeVisible();
    await expect(page.getByTestId("empty")).toContainText("Paste a public npub.");
    await page.getByTestId("lookup-npub").fill("hello");
    await page.getByTestId("lookup-submit").click();
    await expect(page.getByText("That isn't an npub. It starts with npub1.")).toBeVisible();
    expect(lookups).toEqual([]);
    await page.getByTestId("lookup-npub").fill(secret);
    await page.getByTestId("lookup-submit").click();
    await expect(page.getByText("This app never needs it.")).toBeVisible();
    expect(lookups).toEqual([]);
    expect(page.url()).not.toContain(secret);
    await page.getByTestId("lookup-npub").fill(author.npub);
    await page.getByTestId("lookup-submit").click();
    const result = page.getByTestId("lookup-result");
    await expect(result).toBeVisible();
    await expect(page.getByTestId("lookup-name")).toHaveText(`Ada Lovelace, ${shortNpub(author.npub)}`);
    await expect(page.getByTestId("lookup-about")).toHaveText("Public notes about relays.");
    await expect(page.getByTestId("lookup-cadence")).toHaveText("5 public posts. About 8.8 posts a week. Typical gap 24 hours.");
    await expect(page.getByTestId("lookup-mix")).toHaveText("2 notes, 1 reply, 1 quote, 1 repost");
    await expect(page.getByTestId("lookup-pillars")).toContainText("bitcoin");
    await expect(page.getByTestId("lookup-pillars")).toContainText("lightning");
    await expect(page.getByTestId("lookup")).not.toContainText("not on the list");
    await expect(page.getByTestId("lookup")).not.toContainText("should not pillar");
    await expect(page.getByTestId("lookup").getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(page.getByTestId("lookup").getByRole("button", { name: /save|queue|follow|remix/i })).toHaveCount(0);
    expect(lookups).toHaveLength(1);
    expect(page.url()).not.toContain("npub=");
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
    expect(blocking).toEqual([]);
    mkdirSync("/opt/cursor/artifacts", { recursive: true });
    await page.screenshot({ path: "/opt/cursor/artifacts/profile-lookup.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/opt/cursor/artifacts/profile-lookup-narrow.png", fullPage: true });
    await page.keyboard.press("1");
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await page.keyboard.press("9");
    await expect(page.getByRole("heading", { name: "Performance" })).toBeVisible();
    const items = await page.evaluate(async () => {
      const response = await fetch("/api/items?profileId=demo");
      return response.json();
    });
    const research = await page.evaluate(async () => {
      const response = await fetch("/api/research?profileId=demo");
      return response.json();
    });
    expect(items).toEqual([]);
    expect(research).toEqual([]);
    expect(posts).toEqual([]);
    expect(relay.storedIds().slice().sort()).toEqual(before);
  } finally {
    await relay.stop();
    if (child.exitCode === null) child.kill("SIGTERM");
  }
});
