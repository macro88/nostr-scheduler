import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { relayUrl, unixSeconds } from "../src/domain/brand.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { publishToRelay } from "../src/test-relay/client.ts";
import { LocalRelay } from "../src/test-relay/relay.ts";

const mode = { NOSTR_SCHEDULER_MODE: "test" };
const example = readFileSync(new URL("../examples/criteria/example-profile.md", import.meta.url), "utf8");
const hintCopy =
  "Public notes got the most replies, reposts, reactions, and zaps around 18:00 in UTC. Criteria hours stay 09:00 and 18:00 until you edit them.";

test.use({ timezoneId: "UTC" });

function startUi(dataDir: string): Promise<ChildProcess> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, ["src/http/serve.ts"], {
    cwd: root,
    env: {
      ...process.env,
      NOSTR_SCHEDULER_MODE: "test",
      NOSTR_SCHEDULER_DATA: dataDir,
      PORT: "4188",
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
      if (!output.includes("ui http://127.0.0.1:4188")) return;
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

async function showItem(page: Page): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  const item = page.getByTestId("calendar-item");
  try {
    await item.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    await page.getByTestId("next").click();
    await item.waitFor({ state: "visible" });
  }
  await item.click();
}

test("compose shows the hour hint and schedules the chosen time", async ({ page }) => {
  test.setTimeout(60_000);
  const relay = new LocalRelay();
  const url = await relay.start();
  const dir = mkdtempSync(join(tmpdir(), "hour-hint-ui-"));
  const criteriaPath = join(dir, "criteria", "demo.md");
  const operator = createMockSigner(mode);
  const reactor = createMockSigner(mode);
  const criteria = example
    .replace("profile_id: example", "profile_id: demo")
    .replace("timezone: Asia/Hong_Kong", "timezone: UTC");
  mkdirSync(join(dir, "criteria"), { recursive: true });
  writeFileSync(criteriaPath, criteria);
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
      "    criteria_path: criteria/demo.md",
      "",
    ].join("\n"),
  );
  const at = (iso: string) => unixSeconds(Date.parse(iso) / 1000);
  const note = (iso: string, content: string) => operator.signFixture({ kind: 1, created_at: at(iso), tags: [], content });
  const reaction = (target: string, iso: string) =>
    reactor.signFixture({ kind: 7, created_at: at(iso), tags: [["e", target]], content: "+" });
  const quiet = [
    note("2024-01-15T09:00:00Z", "quiet morning"),
    note("2024-01-16T09:00:00Z", "quiet second"),
    note("2024-01-17T09:00:00Z", "quiet third"),
  ];
  const hot = note("2024-01-15T18:00:00Z", "evening note");
  const events = [
    ...quiet,
    hot,
    reaction(quiet[0]?.id ?? "", "2024-01-15T09:05:00Z"),
    reaction(quiet[1]?.id ?? "", "2024-01-16T09:05:00Z"),
    reaction(quiet[2]?.id ?? "", "2024-01-17T09:05:00Z"),
    reaction(hot.id, "2024-01-15T18:05:00Z"),
    reaction(hot.id, "2024-01-15T18:06:00Z"),
    reaction(hot.id, "2024-01-15T18:07:00Z"),
    reaction(hot.id, "2024-01-15T18:08:00Z"),
  ];
  for (const event of events) {
    const result = await publishToRelay(relayUrl(url), event);
    expect(result.accepted).toBe(true);
  }

  let child: ChildProcess | undefined;
  const urls: string[] = [];
  let proposed = 0;
  page.on("request", (request) => {
    urls.push(request.url());
    if (request.method() !== "POST" || !request.url().includes("/api/compose")) return;
    const body = JSON.parse(request.postData() ?? "{}") as { draft?: { proposedFireAt?: number }; preferredHours?: unknown };
    proposed = body.draft?.proposedFireAt ?? 0;
    expect(body.preferredHours).toBeUndefined();
  });
  try {
    child = await startUi(dir);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("http://127.0.0.1:4188/");
    await page.getByTestId("nav-compose").click();
    const composeHint = page.getByRole("group", { name: "When and length" }).getByTestId("hour-hint");
    const before = await page.getByTestId("schedule").innerText();
    await expect(composeHint).toHaveText(hintCopy);
    await expect(page.getByTestId("schedule")).toHaveText(before);
    const target = await page.evaluate(() => {
      const when = new Date(Date.now() + 26 * 60 * 60 * 1000);
      when.setHours(11, 15, 0, 0);
      return {
        day: String(when.getDate()).padStart(2, "0"),
        month: String(when.getMonth() + 1).padStart(2, "0"),
        year: String(when.getFullYear()),
        unix: Math.floor(when.getTime() / 1000),
      };
    });
    await page.getByTestId("schedule").click();
    await page.getByTestId("time-day").fill(target.day);
    await page.getByTestId("time-month").fill(target.month);
    await page.getByTestId("time-year").fill(target.year);
    await page.getByTestId("time-hour").fill("11");
    await page.getByTestId("time-minute").fill("15");
    await page.getByTestId("time-apply").click();
    await expect(page.getByTestId("schedule")).toContainText("11:15");
    await expect(composeHint).toHaveText(hintCopy);
    await page.screenshot({ path: "/opt/cursor/artifacts/hour-hint-compose.png", fullPage: true });
    await page.getByTestId("note-text").fill("Hint leaves the chosen time.");
    await page.getByTestId("save-draft").click();
    await expect(page.getByText("Scheduled locally for")).toBeVisible();
    expect(proposed).toBe(target.unix);
    expect(new Date(proposed * 1000).getUTCHours()).toBe(11);
    expect(new Date(proposed * 1000).getUTCMinutes()).toBe(15);

    await showItem(page);
    await expect(page.getByTestId("calendar-detail").getByTestId("hour-hint")).toHaveText(hintCopy);
    await expect(page.getByTestId("reschedule")).toContainText("11:15");
    await expect(page.getByTestId("save-time")).toBeVisible();
    await page.screenshot({ path: "/opt/cursor/artifacts/hour-hint-calendar.png", fullPage: true });

    const waiting = await page.evaluate(async () => {
      const session = (await (await fetch("/api/session")).json()) as { token: string };
      const response = await fetch("/api/sign/nip07/next", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": session.token },
        body: JSON.stringify({ profileId: "demo" }),
      });
      return { status: response.status, body: (await response.json()) as { itemId?: string; unsigned?: { created_at: number; kind: 1; pubkey: string; tags: string[][]; content: string } } };
    });
    expect(waiting.status).toBe(200);
    expect(waiting.body.unsigned?.created_at).toBe(target.unix);
    const signed = await operator.signEvent(waiting.body.unsigned as unknown as Parameters<typeof operator.signEvent>[0]);
    const submitted = await page.evaluate(async (payload) => {
      const session = (await (await fetch("/api/session")).json()) as { token: string };
      const response = await fetch("/api/sign/nip07/submit", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": session.token },
        body: JSON.stringify({ itemId: payload.itemId, event: payload.event }),
      });
      return { status: response.status, body: await response.json() };
    }, { itemId: waiting.body.itemId, event: signed });
    expect(submitted.status).toBe(200);

    await page.reload();
    await showItem(page);
    await expect(page.getByTestId("calendar-detail").getByTestId("hour-hint")).toHaveText(hintCopy);
    await expect(page.getByTestId("save-time")).toHaveCount(0);
    await expect(page.getByTestId("reschedule")).toHaveCount(0);
    await expect(page.getByTestId("calendar-detail")).toContainText("11:15");
    const rows = await page.evaluate(async () => {
      const response = await fetch("/api/items?profileId=demo");
      return response.json() as Promise<{ status: string; fireAt: number[]; events?: { created_at: number }[] }[]>;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fireAt).toEqual([target.unix]);
    expect(rows[0]?.events?.[0]?.created_at).toBe(target.unix);
    expect(readFileSync(criteriaPath, "utf8")).toBe(criteria);
    expect(urls.some((entry) => entry.includes("/api/items/") && entry.includes("reschedule"))).toBe(false);
    expect(urls.some((entry) => /api\.x\.com|api\.twitter|twitter\.com|\/\/x\.com/i.test(entry))).toBe(false);
    await page.screenshot({ path: "/opt/cursor/artifacts/hour-hint-signed.png", fullPage: true });
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    await relay.stop();
  }
});
