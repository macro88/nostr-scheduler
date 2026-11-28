import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { profileId, relayUrl, unixSeconds } from "../src/domain/brand.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { scanOutliers } from "../src/research/scan.ts";
import { ResearchStore } from "../src/research/store.ts";
import { publishToRelay } from "../src/test-relay/client.ts";
import { LocalRelay } from "../src/test-relay/relay.ts";

const mode = { NOSTR_SCHEDULER_MODE: "test" };
const createdAt = 1_700_000_000;

function startUi(dataDir: string): Promise<ChildProcess> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, ["src/http/serve.ts"], {
    cwd: root,
    env: {
      ...process.env,
      NOSTR_SCHEDULER_MODE: "test",
      NOSTR_SCHEDULER_DATA: dataDir,
      PORT: "4174",
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
      if (!output.includes("ui http://127.0.0.1:4174")) return;
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

test("lists a scanned outlier and selecting it does not approve", async ({ page }) => {
  test.setTimeout(60_000);
  const relay = new LocalRelay();
  const url = await relay.start();
  const dir = mkdtempSync(join(tmpdir(), "outlier-ui-"));
  const operator = createMockSigner(mode);
  const alpha = createMockSigner(mode);
  const beta = createMockSigner(mode);
  const reactor = createMockSigner(mode);
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
  mkdirSync(join(dir, "watch"), { recursive: true });
  writeFileSync(join(dir, "watch", "demo.txt"), `${alpha.npub}\n${beta.npub}\n`);
  const at = (offset: number) => unixSeconds(createdAt + offset);
  const note = (author: ReturnType<typeof createMockSigner>, offset: number, content: string) =>
    author.signFixture({ kind: 1, created_at: at(offset), tags: [], content });
  const alphaQuiet = note(alpha, 1, "alpha quiet");
  const alphaHot = note(alpha, 2, "alpha hot");
  const betaQuiet = note(beta, 3, "beta quiet");
  const betaHot = note(beta, 4, "beta hot");
  const reaction = (target: string, offset: number) =>
    reactor.signFixture({ kind: 7, created_at: at(offset), tags: [["e", target]], content: "+" });
  const events = [
    alphaQuiet,
    reaction(alphaQuiet.id, 11),
    alphaHot,
    reaction(alphaHot.id, 12),
    reaction(alphaHot.id, 13),
    reaction(alphaHot.id, 14),
    reaction(alphaHot.id, 15),
    betaQuiet,
    reaction(betaQuiet.id, 16),
    betaHot,
    reaction(betaHot.id, 17),
    reaction(betaHot.id, 18),
    reaction(betaHot.id, 19),
    reaction(betaHot.id, 20),
  ];
  for (const event of events) {
    const result = await publishToRelay(relayUrl(url), event);
    expect(result.accepted).toBe(true);
  }
  const store = new ResearchStore(join(dir, "research.sqlite"));
  const scanned = await scanOutliers({
    profileId: profileId("demo"),
    authors: [alpha.pubkey, beta.pubkey],
    relays: [relayUrl(url)],
    store,
    now: at(30),
  });
  store.close();
  await relay.stop();
  expect(scanned.hits.map((hit) => hit.content).sort()).toEqual(["alpha hot", "beta hot"]);

  const child = await startUi(dir);
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  try {
    await page.goto("http://127.0.0.1:4174/");
    await page.getByTestId("nav-outliers").click();
    await expect(page.getByRole("heading", { name: "Outliers" })).toBeVisible();
    await expect(page.getByTestId("outlier-row")).toHaveCount(2);
    await page.getByTestId("outlier-row").filter({ hasText: "alpha hot" }).click();
    await expect(page.getByTestId("outlier-detail")).toContainText("alpha hot");
    await expect(page.getByTestId("outlier-detail")).toContainText("4×");
    await expect(page.getByTestId("outlier-detail")).toContainText("0 replies, 0 reposts, 4 reactions, 0 zaps");
    await page.screenshot({ path: "/opt/cursor/artifacts/outliers-selected.png", fullPage: true });
    await expect(page.getByTestId("outliers").getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Outliers" })).toBeVisible();
    const items = await page.evaluate(async () => {
      const response = await fetch("/api/items?profileId=demo");
      return response.json();
    });
    expect(items).toEqual([]);
    expect(posts).toEqual([]);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
});
