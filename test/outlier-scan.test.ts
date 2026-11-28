import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, type RawData } from "ws";
import { describe, expect, test } from "vitest";
import { eventId, hexPubkey, InputError, profileId, relayUrl, signature, unixSeconds } from "../src/domain/brand.ts";
import type { RawEvent } from "../src/domain/event.ts";
import { createApp } from "../src/http/app.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { scoreOutlier } from "../src/research/score.ts";
import { scanOutliers } from "../src/research/scan.ts";
import { ResearchStore } from "../src/research/store.ts";
import { loadWatchAuthors, parseWatchList } from "../src/research/watch.ts";
import { fetchFromRelay } from "../src/test-relay/client.ts";
import { LocalRelay } from "../src/test-relay/relay.ts";

const example = readFileSync(new URL("../examples/criteria/example-profile.md", import.meta.url), "utf8");
const createdAt = 1_700_000_000;
const pubkey = "ab".repeat(32);
const event = "cd".repeat(32);

function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function writeProfile(dir: string, signer: ReturnType<typeof createMockSigner>, relay: string) {
  mkdirSync(join(dir, "criteria"), { recursive: true });
  writeFileSync(join(dir, "criteria", "demo.md"), example.replace("profile_id: example", "profile_id: demo"));
  writeFileSync(
    join(dir, "profiles.yaml"),
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

function staleOutlier() {
  return {
    kind: "outlier",
    id: "res_stale01",
    profileId: "demo",
    authorPubkey: pubkey,
    eventId: event,
    content: "stale note",
    multiplier: 9,
    baseline: 1,
    signals: { replies: 1, reposts: 0, reactions: 0, zaps: 0 },
    createdAt,
    scannedAt: createdAt,
  };
}

function keptBrief() {
  return {
    kind: "brief",
    id: "res_brief01",
    profileId: "demo",
    title: "Morning brief",
    summary: "Five notes worth a look.",
    createdAt,
  };
}

function runCli(dataDir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args, "--data", dataDir], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function publishMany(url: string, events: readonly RawEvent[]): Promise<void> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", () => reject(new Error("relay publish failed to connect")));
  });
  await new Promise<void>((resolve, reject) => {
    let pending = events.length;
    const timer = setTimeout(() => reject(new Error(`relay accepted ${events.length - pending} of ${events.length}`)), 15_000);
    ws.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(textOf(data));
      } catch {
        return;
      }
      if (!Array.isArray(message) || message[0] !== "OK") return;
      if (message[2] !== true) {
        clearTimeout(timer);
        reject(new Error(`relay refused ${String(message[1])}`));
        return;
      }
      pending -= 1;
      if (pending === 0) {
        clearTimeout(timer);
        resolve();
      }
    });
    for (const event of events) ws.send(JSON.stringify(["EVENT", event]));
  });
  ws.close();
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function authed(app: ReturnType<typeof createApp>["app"]) {
  const opened = await app.request("http://127.0.0.1:4173/api/session", { headers: { host: "127.0.0.1:4173" } });
  const body = (await opened.json()) as { token: string };
  const cookie = opened.headers.get("set-cookie")?.split(";")[0] ?? "";
  const headers = {
    host: "127.0.0.1:4173",
    origin: "http://127.0.0.1:4173",
    cookie,
    "x-csrf-token": body.token,
    "content-type": "application/json",
  };
  return {
    get: (path: string) => app.request(`http://127.0.0.1:4173${path}`, { headers: { host: headers.host, cookie } }),
    post: (path: string, payload: unknown) =>
      app.request(`http://127.0.0.1:4173${path}`, { method: "POST", headers, body: JSON.stringify(payload) }),
  };
}

describe("parseWatchList", () => {
  test("reads npubs and skips blanks, comments, and duplicates", () => {
    const author = createMockSigner();
    const text = `\n# curated\r\n${author.npub}\r\n${author.npub}\n`;
    expect(parseWatchList(text)).toEqual([author.pubkey]);
    expect(() => parseWatchList("not-an-npub\n")).toThrow(InputError);
    expect(() => parseWatchList("npub1qqqq\n")).toThrow(InputError);
    const dir = mkdtempSync(join(tmpdir(), "watch-"));
    expect(loadWatchAuthors(dir, profileId("demo"))).toBeNull();
  });
});

describe("scanOutliers store rules", () => {
  test("leaves stored hits when there is no relay or the relay does not answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outlier-store-"));
    const store = new ResearchStore(join(dir, "research.sqlite"));
    try {
      store.insertFixture(staleOutlier());
      store.insertFixture(keptBrief());
      const idle = await scanOutliers({
        profileId: profileId("demo"),
        authors: [hexPubkey(pubkey)],
        relays: [],
        store,
        now: unixSeconds(createdAt + 5),
      });
      expect(idle).toMatchObject({ authors: 1, notes: 0, relayQueries: 0, hits: [] });
      expect(store.list(profileId("demo")).map((row) => row.id)).toEqual(["res_brief01", "res_stale01"]);

      const port = await closedPort();
      await expect(
        scanOutliers({
          profileId: profileId("demo"),
          authors: [hexPubkey(pubkey)],
          relays: [relayUrl(`ws://127.0.0.1:${port}`)],
          store,
          now: unixSeconds(createdAt + 6),
        }),
      ).rejects.toThrow(/connection error/);
      expect(store.list(profileId("demo")).map((row) => row.id)).toEqual(["res_brief01", "res_stale01"]);
    } finally {
      store.close();
    }
  });

  test("an empty watch list removes outlier hits and keeps briefs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outlier-empty-"));
    const store = new ResearchStore(join(dir, "research.sqlite"));
    try {
      store.insertFixture(staleOutlier());
      store.insertFixture(keptBrief());
      const result = await scanOutliers({
        profileId: profileId("demo"),
        authors: [],
        relays: [relayUrl("ws://127.0.0.1:9")],
        store,
        now: unixSeconds(createdAt + 5),
      });
      expect(result).toMatchObject({ authors: 0, notes: 0, relayQueries: 0, hits: [] });
      expect(store.list(profileId("demo"))).toEqual([keptBrief()]);
    } finally {
      store.close();
    }
  });
});

describe("local relay scan", () => {
  test("scores public replies, reposts, reactions, and zaps, and leaves the queue alone", async () => {
    const relay = new LocalRelay();
    const url = await relay.start();
    try {
      const dir = mkdtempSync(join(tmpdir(), "outlier-live-"));
      const operator = createMockSigner();
      const author = createMockSigner();
      const reactor = createMockSigner();
      const other = createMockSigner();
      writeProfile(dir, operator, url);
      mkdirSync(join(dir, "watch"), { recursive: true });
      writeFileSync(join(dir, "watch", "demo.txt"), `# curated\n${author.npub}\n${author.npub}\n`);
      const at = (offset: number) => unixSeconds(createdAt + offset);
      const quietOne = author.signFixture({ kind: 1, created_at: at(1), tags: [], content: "quiet one" });
      const quietTwo = author.signFixture({ kind: 1, created_at: at(2), tags: [], content: "quiet two" });
      const hot = author.signFixture({ kind: 1, created_at: at(3), tags: [], content: "hot note" });
      const blank = author.signFixture({ kind: 1, created_at: at(4), tags: [], content: "   " });
      const outsider = other.signFixture({ kind: 1, created_at: at(5), tags: [], content: "not on the list" });
      const reaction = (target: string, offset: number) =>
        reactor.signFixture({
          kind: 7,
          created_at: at(offset),
          tags: [["e", target], ["p", author.pubkey]],
          content: "+",
        });
      const events = [
        quietOne,
        reaction(quietOne.id, 11),
        reaction(quietOne.id, 12),
        quietTwo,
        reaction(quietTwo.id, 13),
        reaction(quietTwo.id, 14),
        hot,
        reactor.signFixture({
          kind: 1,
          created_at: at(15),
          tags: [["e", hot.id, "", "reply"], ["p", author.pubkey]],
          content: "public reply",
        }),
        reactor.signFixture({
          kind: 6,
          created_at: at(16),
          tags: [["e", hot.id], ["p", author.pubkey]],
          content: "repost",
        }),
        reaction(hot.id, 17),
        reactor.signFixture({
          kind: 9735,
          created_at: at(18),
          tags: [["e", hot.id], ["p", author.pubkey]],
          content: "{}",
        }),
        blank,
        outsider,
        reaction(outsider.id, 19),
        {
          id: eventId("11".repeat(32)),
          pubkey: hexPubkey("22".repeat(32)),
          created_at: at(20),
          kind: 7,
          tags: [["e", hot.id] satisfies [string, string]],
          content: "+",
          sig: signature("33".repeat(64)),
        } satisfies RawEvent,
      ];
      const store = new ResearchStore(join(dir, "research.sqlite"));
      try {
        await publishMany(url, events);
        store.insertFixture(staleOutlier());
        store.insertFixture(keptBrief());
        const scannedAt = unixSeconds(createdAt + 50);
        const result = await scanOutliers({
          profileId: profileId("demo"),
          authors: [author.pubkey, author.pubkey],
          relays: [relayUrl(url)],
          store,
          now: scannedAt,
        });
        expect(result.authors).toBe(1);
        expect(result.notes).toBe(3);
        expect(result.relayQueries).toBe(2);
        expect(result.hits).toHaveLength(1);
        const hit = result.hits[0];
        if (!hit) throw new Error("missing hit");
        expect(hit.content).toBe("hot note");
        expect(hit.authorPubkey).toBe(author.pubkey);
        expect(hit.eventId).toBe(hot.id);
        expect(hit.signals).toEqual({ replies: 1, reposts: 1, reactions: 1, zaps: 1 });
        expect(hit.baseline).toBe(2);
        expect(hit.multiplier).toBe(2);
        expect(hit.scannedAt).toBe(scannedAt);
        expect(hit.createdAt).toBe(at(3));
        const stored = store.list(profileId("demo"));
        expect(stored.filter((row) => row.kind === "brief")).toHaveLength(1);
        expect(stored.filter((row) => row.kind === "outlier").map((row) => (row.kind === "outlier" ? row.content : ""))).toEqual([
          "hot note",
        ]);
      } finally {
        store.close();
      }

      const cli = await runCli(dir, ["research", "scan", "demo"]);
      expect(cli.code).toBe(0);
      expect(cli.stdout).toContain("demo authors 1 notes 3 hits 1 queries 2");
      const again = await runCli(dir, ["research", "scan", "demo"]);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("hits 1");

      const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(createdAt + 80) });
      try {
        const api = await authed(app);
        const research = (await (await api.get("/api/research?profileId=demo")).json()) as { id: string; kind: string; content?: string }[];
        const outliers = research.filter((row) => row.kind === "outlier");
        expect(outliers).toHaveLength(1);
        expect(outliers[0]?.content).toBe("hot note");
        expect(research.some((row) => row.kind === "brief")).toBe(true);
        expect(await (await api.get("/api/items?profileId=demo")).json()).toEqual([]);
        const suggested = await api.post("/api/suggestions", {
          profileId: "demo",
          rationale: "because",
          draft: { type: "note", content: "A queued note", proposedFireAt: createdAt + 100 },
        });
        expect(suggested.status).toBe(200);
        const suggestion = (await suggested.json()) as { id: string };
        const items = (await (await api.get("/api/items?profileId=demo")).json()) as { id: string }[];
        const listed = (await (await api.get("/api/research?profileId=demo")).json()) as { id: string; content?: string }[];
        expect(items.map((item) => item.id)).toEqual([suggestion.id]);
        expect(JSON.stringify(items)).not.toContain("hot note");
        expect(JSON.stringify(listed)).not.toContain(suggestion.id);
        expect(JSON.stringify(listed)).not.toContain("stale note");
        expect(JSON.stringify(listed)).not.toContain("not on the list");
      } finally {
        close();
      }
    } finally {
      await relay.stop();
    }
  }, 30_000);

  test("a missing watch list does not change stored hits, and a bad line fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outlier-cli-"));
    writeProfile(dir, createMockSigner(), "ws://127.0.0.1:9");
    const store = new ResearchStore(join(dir, "research.sqlite"));
    store.insertFixture(staleOutlier());
    store.close();
    const missing = await runCli(dir, ["research", "scan", "demo"]);
    expect(missing.code).toBe(0);
    expect(missing.stdout).toContain("demo no watch list");
    const kept = new ResearchStore(join(dir, "research.sqlite"));
    expect(kept.list(profileId("demo")).map((row) => row.id)).toEqual(["res_stale01"]);
    kept.close();

    mkdirSync(join(dir, "watch"), { recursive: true });
    writeFileSync(join(dir, "watch", "demo.txt"), "not-an-npub\n");
    const bad = await runCli(dir, ["research", "scan", "demo"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("npub: line 1 is not an npub");
  });
});

function summarize(samples: readonly number[]): { median: number; min: number; max: number } {
  const ordered = [...samples].sort((left, right) => left - right);
  return { median: ordered[2] ?? 0, min: ordered[0] ?? 0, max: ordered[4] ?? 0 };
}

describe("outlier scan timing", () => {
  test("scans 10 authors by 50 notes under the local relay line", async () => {
    const relay = new LocalRelay();
    const url = await relay.start();
    const dir = mkdtempSync(join(tmpdir(), "outlier-perf-"));
    const operator = createMockSigner();
    const authors = Array.from({ length: 10 }, () => createMockSigner());
    const reactor = createMockSigner();
    writeProfile(dir, operator, url);
    mkdirSync(join(dir, "watch"), { recursive: true });
    writeFileSync(join(dir, "watch", "demo.txt"), authors.map((author) => author.npub).join("\n") + "\n");
    const events: RawEvent[] = [];
    for (let authorIndex = 0; authorIndex < authors.length; authorIndex += 1) {
      const author = authors[authorIndex];
      if (!author) throw new Error("missing author");
      for (let noteIndex = 0; noteIndex < 50; noteIndex += 1) {
        const hot = noteIndex === 49;
        const note = author.signFixture({
          kind: 1,
          created_at: unixSeconds(createdAt + authorIndex * 100 + noteIndex),
          tags: [],
          content: hot ? `hot ${authorIndex}` : `quiet ${authorIndex} ${noteIndex}`,
        });
        events.push(note);
        if (!hot) continue;
        for (let reactionIndex = 0; reactionIndex < 4; reactionIndex += 1) {
          events.push(
            reactor.signFixture({
              kind: 7,
              created_at: unixSeconds(createdAt + 20_000 + authorIndex * 10 + reactionIndex),
              tags: [["e", note.id]],
              content: "+",
            }),
          );
        }
      }
    }
    const store = new ResearchStore(join(dir, "research.sqlite"));
    try {
      await publishMany(url, events);
      const firstAuthor = authors[0];
      if (!firstAuthor) throw new Error("missing author");
      const probeStart = performance.now();
      const probed = await fetchFromRelay(relayUrl(url), { kinds: [1], authors: [firstAuthor.pubkey], limit: 50 }, { strict: true });
      const probeMs = performance.now() - probeStart;
      expect(probed).toHaveLength(50);
      const scoreStart = performance.now();
      for (let index = 0; index < 500; index += 1) scoreOutlier({ baselineEngagement: 0, postEngagement: 4 });
      const scoreMs = performance.now() - scoreStart;
      const scan = () =>
        scanOutliers({
          profileId: profileId("demo"),
          authors: authors.map((author) => author.pubkey),
          relays: [relayUrl(url)],
          store,
          now: unixSeconds(createdAt + 30),
        });
      const warmup = await scan();
      expect(warmup.notes).toBe(500);
      expect(warmup.relayQueries).toBe(20);
      expect(warmup.hits).toHaveLength(10);
      const samples: number[] = [];
      for (let run = 0; run < 5; run += 1) {
        const start = performance.now();
        const result = await scan();
        const elapsed = performance.now() - start;
        const hot = result.hits.find((hit) => hit.content === "hot 0");
        const stored = store.list(profileId("demo")).filter((row) => row.kind === "outlier");
        if (
          result.authors !== 10 ||
          result.notes !== 500 ||
          result.relayQueries !== 20 ||
          result.hits.length !== 10 ||
          stored.length !== 10 ||
          hot?.multiplier !== 4 ||
          hot.baseline !== 0 ||
          hot.signals.reactions !== 4 ||
          hot.signals.replies !== 0
        ) {
          throw new Error("timed scan did not read and store the 10 by 50 fixture");
        }
        samples.push(elapsed);
      }
      const summary = summarize(samples);
      const report = {
        unit: "ms",
        authors: 10,
        notesPerAuthor: 50,
        relayQueries: 20,
        runs: samples,
        summary,
        probeMs,
        scoreLoopMs: scoreMs,
        loadavg: loadavg(),
        cores: availableParallelism(),
        errors: 0,
      };
      console.log(JSON.stringify(report));
      expect(summary.max, "10 authors by 50 notes must stay under 5 s").toBeLessThan(5000);
    } finally {
      store.close();
      await relay.stop();
    }
  }, 60_000);
});
