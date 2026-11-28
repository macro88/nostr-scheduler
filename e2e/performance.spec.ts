import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { relayUrl, unixSeconds } from "../src/domain/brand.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { publishToRelay } from "../src/test-relay/client.ts";
import { LocalRelay } from "../src/test-relay/relay.ts";

const mode = { NOSTR_SCHEDULER_MODE: "test" };
const createdAt = 1_700_100_000;

function startUi(dataDir: string): Promise<ChildProcess> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, ["src/http/serve.ts"], {
    cwd: root,
    env: {
      ...process.env,
      NOSTR_SCHEDULER_MODE: "test",
      NOSTR_SCHEDULER_DATA: dataDir,
      PORT: "4187",
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
      if (!output.includes("ui http://127.0.0.1:4187")) return;
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

test("shows do more and do less bands for the operator notes", async ({ page }) => {
  test.setTimeout(60_000);
  const relay = new LocalRelay();
  const url = await relay.start();
  const dir = mkdtempSync(join(tmpdir(), "perf-ui-"));
  const operator = createMockSigner(mode);
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
  mkdirSync(join(dir, "criteria"), { recursive: true });
  const at = (offset: number) => unixSeconds(createdAt + offset);
  const note = (offset: number, content: string) =>
    operator.signFixture({ kind: 1, created_at: at(offset), tags: [], content });
  const reaction = (target: string, offset: number) =>
    reactor.signFixture({ kind: 7, created_at: at(offset), tags: [["e", target]], content: "+" });
  const quiet = note(1, "quiet day note");
  const hot = note(2, "hot day note");
  const mid = note(3, "middle day note");
  const cold = note(4, "cold day note");
  const warm = note(5, "warm day note");
  const events = [
    quiet,
    reaction(quiet.id, 11),
    mid,
    reaction(mid.id, 12),
    reaction(mid.id, 13),
    warm,
    reaction(warm.id, 14),
    reaction(warm.id, 15),
    reaction(warm.id, 16),
    hot,
    reaction(hot.id, 17),
    reaction(hot.id, 18),
    reaction(hot.id, 19),
    reaction(hot.id, 20),
    reaction(hot.id, 21),
    cold,
  ];
  for (const event of events) {
    const result = await publishToRelay(relayUrl(url), event);
    expect(result.accepted).toBe(true);
  }

  const child = await startUi(dir);
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  try {
    await page.goto("http://127.0.0.1:4187/");
    await page.getByTestId("nav-performance").click();
    await expect(page.getByRole("heading", { name: "Performance" })).toBeVisible();
    await expect(page.getByTestId("band-top")).toContainText("hot day note");
    await expect(page.getByTestId("band-top")).toContainText("Do more");
    await expect(page.getByTestId("band-bottom")).toContainText("cold day note");
    await expect(page.getByTestId("band-bottom")).toContainText("Do less");
    await expect(page.getByTestId("band-middle")).toHaveText("3 notes sit between the bands.");
    await expect(page.getByTestId("performance-note")).toHaveCount(2);
    await page.screenshot({ path: "/opt/cursor/artifacts/performance-bands.png", fullPage: true });
    await expect(page.getByTestId("performance").getByRole("button", { name: "Approve" })).toHaveCount(0);
    const items = await page.evaluate(async () => {
      const response = await fetch("/api/items?profileId=demo");
      return response.json();
    });
    expect(items).toEqual([]);
    expect(posts).toEqual([]);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await relay.stop();
  }
});
