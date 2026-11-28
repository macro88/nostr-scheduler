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
      PORT: "4175",
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
      if (!output.includes("ui http://127.0.0.1:4175")) return;
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

test("shows the operator's own notes with multipliers and bands", async ({ page }) => {
  test.setTimeout(60_000);
  const relay = new LocalRelay();
  const url = await relay.start();
  const dir = mkdtempSync(join(tmpdir(), "performance-ui-"));
  const operator = createMockSigner(mode);
  const reactor = createMockSigner(mode);
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
  const note = (offset: number, content: string) => operator.signFixture({ kind: 1, created_at: at(offset), tags: [], content });
  const quiet = Array.from({ length: 8 }, (_, index) => note(index + 1, `quiet ${index + 1}`));
  const steady = note(9, "steady note");
  const hot = note(10, "hot note");
  const outsider = other.signFixture({ kind: 1, created_at: at(12), tags: [], content: "not mine" });
  const reaction = (target: string, offset: number) =>
    reactor.signFixture({ kind: 7, created_at: at(offset), tags: [["e", target]], content: "+" });
  const events = [
    ...quiet,
    steady,
    reaction(steady.id, 20),
    reaction(steady.id, 21),
    hot,
    reactor.signFixture({ kind: 1, created_at: at(22), tags: [["e", hot.id]], content: "public reply" }),
    reactor.signFixture({ kind: 6, created_at: at(23), tags: [["e", hot.id]], content: "repost" }),
    reaction(hot.id, 24),
    reactor.signFixture({ kind: 9735, created_at: at(25), tags: [["e", hot.id]], content: "{}" }),
    outsider,
    reaction(outsider.id, 26),
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
    await page.goto("http://127.0.0.1:4175/");
    await expect(page.getByTestId("nav-performance")).toBeVisible();
    const order = await page.locator("nav[aria-label='Sections'] button").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-testid")),
    );
    expect(order).toEqual([
      "nav-inbox",
      "nav-compose",
      "nav-board",
      "nav-calendar",
      "nav-log",
      "nav-sign",
      "nav-outliers",
      "nav-research",
      "nav-performance",
      "nav-lookup",
    ]);
    await page.getByTestId("nav-performance").click();
    await expect(page.getByRole("heading", { name: "Performance" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Do more" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Do less" })).toBeVisible();
    const top = page.getByTestId("band-top");
    const bottom = page.getByTestId("band-bottom");
    await expect(top).toContainText("hot note");
    await expect(top).toContainText("18×");
    await expect(top).toContainText("steady note");
    await expect(top).toContainText("4.5×");
    await expect(top).toContainText("1 reply, 1 repost, 1 reaction, 1 zap");
    await expect(bottom).toContainText("quiet 1");
    await expect(bottom).toContainText("quiet 2");
    await expect(bottom).toContainText("0×");
    await expect(page.getByTestId("band-middle")).toHaveText("6 notes are between the bands.");
    await expect(bottom).toContainText("0 replies, 0 reposts, 0 reactions, 0 zaps");
    await expect(page.getByTestId("performance")).not.toContainText("not mine");
    await expect(page.getByTestId("performance").getByRole("button", { name: "Approve" })).toHaveCount(0);
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
    expect(blocking).toEqual([]);
    mkdirSync("/opt/cursor/artifacts", { recursive: true });
    await page.screenshot({ path: "/opt/cursor/artifacts/performance-bands.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/opt/cursor/artifacts/performance-narrow.png", fullPage: true });
    await page.keyboard.press("1");
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await page.keyboard.press("8");
    await expect(page.getByTestId("nav-research")).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("9");
    await expect(page.getByRole("heading", { name: "Performance" })).toBeVisible();
    const items = await page.evaluate(async () => {
      const response = await fetch("/api/items?profileId=demo");
      return response.json();
    });
    expect(items).toEqual([]);
    expect(posts).toEqual([]);
  } finally {
    await relay.stop();
    if (child.exitCode === null) child.kill("SIGTERM");
  }
});
