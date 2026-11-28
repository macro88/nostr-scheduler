import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type RawData } from "ws";
import { describe, expect, test } from "vitest";
import { relayUrl, unixSeconds } from "../src/domain/brand.ts";
import type { RawEvent } from "../src/domain/event.ts";
import { createApp } from "../src/http/app.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { assignPerformanceBands, scanPerformance } from "../src/research/performance.ts";
import { loadAuthorNotes, loadSignalTallies } from "../src/research/public-notes.ts";
import { LocalRelay } from "../src/test-relay/relay.ts";

const createdAt = 1_700_000_000;
const mode = { NOSTR_SCHEDULER_MODE: "test" };
const example = readFileSync(new URL("../examples/criteria/example-profile.md", import.meta.url), "utf8");

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

type PerformanceNote = {
  content: string;
  multiplier: number;
  baseline: number;
  label: "Do more" | "Do less" | null;
  band: string;
  signals: { replies: number; reposts: number; reactions: number; zaps: number };
};

type PerformanceReport = {
  fraction: number;
  topCutoff: number | null;
  bottomCutoff: number | null;
  notes: PerformanceNote[];
  relayQueries: number;
};

function summarize(samples: readonly number[]): { median: number; min: number; max: number } {
  const ordered = [...samples].sort((left, right) => left - right);
  return { median: ordered[2] ?? 0, min: ordered[0] ?? 0, max: ordered[4] ?? 0 };
}

describe("operator performance on a local relay", () => {
  test("scores the operator's public notes and leaves the queue empty", async () => {
    const relay = new LocalRelay();
    const url = await relay.start();
    try {
      const dir = mkdtempSync(join(tmpdir(), "performance-live-"));
      const operator = createMockSigner(mode);
      const reactor = createMockSigner(mode);
      const other = createMockSigner(mode);
      writeProfile(dir, operator, url);
      const at = (offset: number) => unixSeconds(createdAt + offset);
      const note = (offset: number, content: string) =>
        operator.signFixture({ kind: 1, created_at: at(offset), tags: [], content });
      const quiet = Array.from({ length: 8 }, (_, index) => note(index + 1, `quiet ${index + 1}`));
      const steady = note(9, "steady note");
      const hot = note(10, "hot note");
      const blank = operator.signFixture({ kind: 1, created_at: at(11), tags: [], content: "   " });
      const outsider = other.signFixture({ kind: 1, created_at: at(12), tags: [], content: "not mine" });
      const reaction = (author: ReturnType<typeof createMockSigner>, target: string, offset: number) =>
        author.signFixture({ kind: 7, created_at: at(offset), tags: [["e", target]], content: "+" });
      const events = [
        ...quiet,
        steady,
        reaction(reactor, steady.id, 20),
        reaction(reactor, steady.id, 21),
        hot,
        reactor.signFixture({ kind: 1, created_at: at(22), tags: [["e", hot.id]], content: "public reply" }),
        reactor.signFixture({ kind: 6, created_at: at(23), tags: [["e", hot.id]], content: "repost" }),
        reaction(reactor, hot.id, 24),
        reactor.signFixture({ kind: 9735, created_at: at(25), tags: [["e", hot.id]], content: "{}" }),
        blank,
        outsider,
        reaction(reactor, outsider.id, 26),
      ];
      await publishMany(url, events);
      const scannedAt = unixSeconds(createdAt + 50);
      const scanned = await scanPerformance({
        pubkey: operator.pubkey,
        relays: [relayUrl(url)],
        now: scannedAt,
      });
      expect(scanned.relayQueries).toBe(2);
      expect(scanned.scannedAt).toBe(scannedAt);
      expect(scanned.notes).toHaveLength(10);
      expect(scanned.notes.map((row) => row.content)).not.toContain("not mine");
      expect(scanned.notes.map((row) => row.content)).not.toContain("   ");
      const hotRow = scanned.notes.find((row) => row.content === "hot note");
      const steadyRow = scanned.notes.find((row) => row.content === "steady note");
      if (!hotRow || !steadyRow) throw new Error("missing scored notes");
      expect(hotRow.signals).toEqual({ replies: 1, reposts: 1, reactions: 1, zaps: 1 });
      expect(steadyRow.signals).toEqual({ replies: 0, reposts: 0, reactions: 2, zaps: 0 });
      expect(hotRow.multiplier).toBeCloseTo(18, 8);
      expect(steadyRow.multiplier).toBeCloseTo(4.5, 8);
      expect(hotRow.baseline).toBeCloseTo(2 / 9, 8);
      expect(steadyRow.baseline).toBeCloseTo(4 / 9, 8);
      expect(hotRow.label).toBe("Do more");
      expect(steadyRow.label).toBe("Do more");
      expect(scanned.topCutoff).toBeCloseTo(4.5, 8);
      expect(scanned.bottomCutoff).toBe(0);
      expect(scanned.notes.filter((row) => row.label === "Do less").map((row) => row.content)).toEqual(["quiet 2", "quiet 1"]);
      expect(scanned.notes.filter((row) => row.label === null)).toHaveLength(6);

      const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(createdAt + 80) });
      try {
        const api = await authed(app);
        expect((await api.get("/api/performance")).status).toBe(400);
        const response = await api.get("/api/performance?profileId=demo");
        expect(response.status).toBe(200);
        const report = (await response.json()) as PerformanceReport;
        expect(report.fraction).toBe(0.2);
        expect(report.relayQueries).toBe(2);
        expect(report.notes).toHaveLength(10);
        expect(report.topCutoff).toBeCloseTo(4.5, 8);
        expect(report.bottomCutoff).toBe(0);
        const shown = report.notes.find((row) => row.content === "hot note");
        expect(shown?.label).toBe("Do more");
        expect(shown?.multiplier).toBeCloseTo(18, 8);
        expect(shown?.signals).toEqual({ replies: 1, reposts: 1, reactions: 1, zaps: 1 });
        expect(report.notes.filter((row) => row.label === "Do less").map((row) => row.content)).toEqual(["quiet 2", "quiet 1"]);
        expect(await (await api.get("/api/items?profileId=demo")).json()).toEqual([]);
        expect(await (await api.get("/api/research?profileId=demo")).json()).toEqual([]);
        const suggested = await api.post("/api/suggestions", {
          profileId: "demo",
          rationale: "because",
          draft: { type: "note", content: "A queued note", proposedFireAt: createdAt + 3_600 },
        });
        if (suggested.status !== 200) {
          throw new Error(`suggest failed ${suggested.status}: ${await suggested.text()}`);
        }
        const again = (await (await api.get("/api/performance?profileId=demo")).json()) as PerformanceReport;
        expect(again.notes).toHaveLength(10);
        expect(JSON.stringify(again.notes)).not.toContain("A queued note");
        const items = (await (await api.get("/api/items?profileId=demo")).json()) as { id: string }[];
        expect(items).toHaveLength(1);
      } finally {
        close();
      }
    } finally {
      await relay.stop();
    }
  }, 30_000);

  test("a dead relay is an error, not an empty band", async () => {
    const port = await closedPort();
    const dir = mkdtempSync(join(tmpdir(), "performance-down-"));
    const operator = createMockSigner(mode);
    writeProfile(dir, operator, `ws://127.0.0.1:${port}`);
    const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(createdAt) });
    try {
      const api = await authed(app);
      const response = await api.get("/api/performance?profileId=demo");
      expect(response.status).toBe(400);
      expect(await (await api.get("/api/items?profileId=demo")).json()).toEqual([]);
    } finally {
      close();
    }
  });
});

describe("performance scan timing", () => {
  test("scans 100 of the operator's notes under 5s on the local relay", async () => {
    const relay = new LocalRelay();
    const url = await relay.start();
    const dir = mkdtempSync(join(tmpdir(), "performance-perf-"));
    const operator = createMockSigner(mode);
    const reactor = createMockSigner(mode);
    writeProfile(dir, operator, url);
    const notes: RawEvent[] = [];
    const reactions: RawEvent[] = [];
    for (let index = 0; index < 100; index += 1) {
      const note = operator.signFixture({
        kind: 1,
        created_at: unixSeconds(createdAt + index),
        tags: [],
        content: index >= 80 ? `hot ${index}` : `quiet ${index}`,
      });
      notes.push(note);
      if (index < 80) continue;
      reactions.push(
        reactor.signFixture({
          kind: 7,
          created_at: unixSeconds(createdAt + 1_000 + index),
          tags: [["e", note.id]],
          content: "+",
        }),
      );
    }
    try {
      await publishMany(url, [...notes, ...reactions]);
      const relayRef = relayUrl(url);
      const profileQueries = { count: 0 };
      const noteStart = performance.now();
      const loaded = await loadAuthorNotes(operator.pubkey, [relayRef], profileQueries, 100);
      const noteMs = performance.now() - noteStart;
      const tallyStart = performance.now();
      const tallies = await loadSignalTallies(loaded, [relayRef], profileQueries);
      const tallyMs = performance.now() - tallyStart;
      let reactionCount = 0;
      for (const tally of tallies.values()) reactionCount += tally.reactions;
      const bandStart = performance.now();
      const probed = assignPerformanceBands(
        loaded.map((note, index) => ({ eventId: note.id, createdAt: note.created_at, multiplier: index })),
      );
      const bandMs = performance.now() - bandStart;
      expect(loaded).toHaveLength(100);
      expect(reactionCount).toBe(20);
      expect(probed.notes).toHaveLength(100);
      expect(profileQueries.count).toBe(2);

      const scan = () =>
        scanPerformance({
          pubkey: operator.pubkey,
          relays: [relayRef],
          now: unixSeconds(createdAt + 2_000),
        });
      const warmup = await scan();
      expect(warmup.notes).toHaveLength(100);
      expect(warmup.relayQueries).toBe(2);
      const samples: number[] = [];
      for (let run = 0; run < 5; run += 1) {
        const start = performance.now();
        const result = await scan();
        const elapsed = performance.now() - start;
        const hot = result.notes.filter((row) => row.label === "Do more");
        const quiet = result.notes.filter((row) => row.label === "Do less");
        const known = result.notes.find((row) => row.content === "hot 99");
        if (
          result.notes.length !== 100 ||
          result.relayQueries !== 2 ||
          hot.length !== 20 ||
          quiet.length !== 20 ||
          hot.some((row) => row.signals.reactions !== 1) ||
          quiet.some((row) => row.signals.reactions !== 0) ||
          known?.label !== "Do more" ||
          Math.abs((known?.multiplier ?? 0) - 99 / 19) > 1e-8
        ) {
          throw new Error("timed scan did not score all 100 notes");
        }
        samples.push(elapsed);
      }
      const summary = summarize(samples);
      const limiter = noteMs >= tallyMs && noteMs >= bandMs ? "note fetch" : tallyMs >= bandMs ? "signal fetch" : "band assign";
      const report = {
        claim: "100 local notes with reactions, median under 5s, fail above 20s",
        unit: "ms",
        notes: 100,
        reactions: 20,
        relayQueries: 2,
        runs: samples,
        summary,
        profileMs: { noteFetch: noteMs, signalFetch: tallyMs, bandAssign: bandMs },
        limiter,
        loadavg: loadavg(),
        cores: availableParallelism(),
        errors: 0,
      };
      mkdirSync("/opt/cursor/artifacts", { recursive: true });
      writeFileSync("/opt/cursor/artifacts/performance-scan.json", `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify(report));
      expect(summary.max, "fail above 20s").toBeLessThan(20_000);
      expect(summary.median, "100 notes stay under 5s on the local relay").toBeLessThan(5_000);
    } finally {
      await relay.stop();
    }
  }, 60_000);
});
