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
import { classifyPost, PROFILE_LOOKUP_LIMIT, profilePatterns, type ProfileLookup } from "../src/research/profile-lookup.ts";
import { loadAuthorEvents } from "../src/research/public-notes.ts";
import { LocalRelay } from "../src/test-relay/relay.ts";

const createdAt = 1_700_000_000;
const mode = { NOSTR_SCHEDULER_MODE: "test" };
const example = readFileSync(new URL("../examples/criteria/example-profile.md", import.meta.url), "utf8");
const secret = "nsec1notarealkeyxxxxxxxx";

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
  };
}

function summarize(samples: readonly number[]): { median: number; min: number; max: number } {
  const ordered = [...samples].sort((left, right) => left - right);
  return { median: ordered[2] ?? 0, min: ordered[0] ?? 0, max: ordered[4] ?? 0 };
}

describe("profile lookup on a local relay", () => {
  test("reads one public npub and does not create a work item", async () => {
    const relay = new LocalRelay();
    const url = await relay.start();
    const dir = mkdtempSync(join(tmpdir(), "profile-lookup-"));
    const operator = createMockSigner(mode);
    const author = createMockSigner(mode);
    const other = createMockSigner(mode);
    writeProfile(dir, operator, url);
    const at = (offset: number) => unixSeconds(createdAt + offset);
    const card = author.signFixture({
      kind: 0,
      created_at: at(-10),
      tags: [],
      content: JSON.stringify({ name: "ada", display_name: "Ada Lovelace", about: "Public notes about relays." }),
    });
    const note = author.signFixture({ kind: 1, created_at: at(0), tags: [], content: "Bitcoin and lightning keep the lights on" });
    const fees = author.signFixture({ kind: 1, created_at: at(86_400), tags: [], content: "Bitcoin fees fell again today" });
    const reply = author.signFixture({
      kind: 1,
      created_at: at(172_800),
      tags: [["e", note.id, "", "reply"]],
      content: "Lightning channels opened overnight",
    });
    const quote = author.signFixture({
      kind: 1,
      created_at: at(259_200),
      tags: [["q", note.id]],
      content: "A quoted bitcoin thread",
    });
    const repost = author.signFixture({
      kind: 6,
      created_at: at(345_600),
      tags: [["e", note.id]],
      content: "bitcoin should not pillar from a repost",
    });
    const blank = author.signFixture({ kind: 1, created_at: at(400_000), tags: [], content: "   " });
    const outsider = other.signFixture({ kind: 1, created_at: at(10), tags: [], content: "not on the list" });
    try {
      await publishMany(url, [card, note, fees, reply, quote, repost, blank, outsider]);
      const before = relay.storedIds().slice().sort();
      const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(createdAt + 500_000) });
      try {
        const api = await authed(app);
        const response = await api.get(`/api/profile-lookup?profileId=demo&npub=${encodeURIComponent(author.npub)}`);
        expect(response.status).toBe(200);
        const report = (await response.json()) as ProfileLookup;
        expect(report.npub).toBe(author.npub);
        expect(report.pubkey).toBe(author.pubkey);
        expect(report.metadata).toEqual({ name: "Ada Lovelace", about: "Public notes about relays." });
        expect(report.cadence).toEqual({
          posts: 5,
          spanSeconds: 345_600,
          postsPerWeek: (5 * 604_800) / 345_600,
          medianGapSeconds: 86_400,
        });
        expect(report.mix).toEqual({ note: 2, reply: 1, quote: 1, repost: 1 });
        expect(report.pillars).toEqual([
          { label: "bitcoin", notes: 3 },
          { label: "lightning", notes: 2 },
        ]);
        expect(report.relayQueries).toBe(2);
        expect(JSON.stringify(report)).not.toContain("not on the list");
        expect(JSON.stringify(report)).not.toContain("should not pillar");
        expect(await (await api.get("/api/items?profileId=demo")).json()).toEqual([]);
        expect(await (await api.get("/api/research?profileId=demo")).json()).toEqual([]);
        expect(relay.storedIds().slice().sort()).toEqual(before);
        const again = (await (await api.get(`/api/profile-lookup?profileId=demo&npub=${encodeURIComponent(author.npub.toUpperCase())}`)).json()) as ProfileLookup;
        expect(again.pillars).toEqual(report.pillars);
        expect(await (await api.get("/api/items?profileId=demo")).json()).toEqual([]);

        const missing = await api.get("/api/profile-lookup?profileId=demo");
        expect(missing.status).toBe(400);
        const rejected = await api.get(`/api/profile-lookup?profileId=demo&npub=${encodeURIComponent(secret)}`);
        expect(rejected.status).toBe(400);
        const rejectedBody = JSON.stringify(await rejected.json());
        expect(rejectedBody).not.toContain(secret);
        expect(await (await api.get("/api/items?profileId=demo")).json()).toEqual([]);
      } finally {
        close();
      }
    } finally {
      await relay.stop();
    }
  });

  test("a dead relay is an error and still creates no work item", async () => {
    const port = await closedPort();
    const dir = mkdtempSync(join(tmpdir(), "profile-lookup-dead-"));
    const operator = createMockSigner(mode);
    const author = createMockSigner(mode);
    writeProfile(dir, operator, `ws://127.0.0.1:${port}`);
    const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(createdAt) });
    try {
      const api = await authed(app);
      const response = await api.get(`/api/profile-lookup?profileId=demo&npub=${encodeURIComponent(author.npub)}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "relays: The relays did not answer." });
      expect(await (await api.get("/api/items?profileId=demo")).json()).toEqual([]);
    } finally {
      close();
    }
  });
});

describe("profile lookup timing", () => {
  test("looks up 100 local notes under 5s", async () => {
    const relay = new LocalRelay();
    const url = await relay.start();
    const dir = mkdtempSync(join(tmpdir(), "profile-lookup-perf-"));
    const operator = createMockSigner(mode);
    const author = createMockSigner(mode);
    writeProfile(dir, operator, url);
    const notes: RawEvent[] = [];
    for (let index = 0; index < 100; index += 1) {
      const reply = index >= 90;
      notes.push(
        author.signFixture({
          kind: 1,
          created_at: unixSeconds(createdAt + index * 3_600),
          tags: reply ? [["e", "ab", "", "reply"]] : [],
          content: index < 40 ? `bitcoin note ${index}` : `quiet note ${index}`,
        }),
      );
    }
    const card = author.signFixture({
      kind: 0,
      created_at: unixSeconds(createdAt - 10),
      tags: [],
      content: JSON.stringify({ display_name: "Ada", about: "notes" }),
    });
    try {
      await publishMany(url, [card, ...notes]);
      const relayRef = relayUrl(url);
      const queries = { count: 0 };
      const kindStart = performance.now();
      const loadedCard = await loadAuthorEvents(author.pubkey, [relayRef], queries, [0], 20);
      const kindMs = performance.now() - kindStart;
      const noteStart = performance.now();
      const loaded = await loadAuthorEvents(author.pubkey, [relayRef], queries, [1, 6], PROFILE_LOOKUP_LIMIT);
      const noteMs = performance.now() - noteStart;
      const patternStart = performance.now();
      const probed = profilePatterns(
        loaded.flatMap((event) => {
          const type = classifyPost(event);
          return type ? [{ createdAt: event.created_at, content: event.content, type }] : [];
        }),
      );
      const patternMs = performance.now() - patternStart;
      expect(loadedCard).toHaveLength(1);
      expect(loaded).toHaveLength(100);
      expect(probed.cadence.posts).toBe(100);
      expect(probed.mix).toEqual({ note: 90, reply: 10, quote: 0, repost: 0 });
      expect(probed.pillars).toContainEqual({ label: "bitcoin", notes: 40 });
      expect(probed.pillars).toContainEqual({ label: "quiet", notes: 60 });

      const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(createdAt + 500_000) });
      try {
        const api = await authed(app);
        const path = `/api/profile-lookup?profileId=demo&npub=${encodeURIComponent(author.npub)}`;
        const once = async () => {
          const response = await api.get(path);
          if (response.status !== 200) throw new Error(`lookup status ${response.status}`);
          return (await response.json()) as ProfileLookup;
        };
        const warmup = await once();
        expect(warmup.cadence.posts).toBe(100);
        expect(warmup.relayQueries).toBe(2);
        expect(warmup.metadata.name).toBe("Ada");
        const samples: number[] = [];
        for (let run = 0; run < 5; run += 1) {
          const start = performance.now();
          const result = await once();
          const elapsed = performance.now() - start;
          const bitcoin = result.pillars.find((pillar) => pillar.label === "bitcoin");
          if (
            result.cadence.posts !== 100 ||
            result.mix.note !== 90 ||
            result.mix.reply !== 10 ||
            result.relayQueries !== 2 ||
            bitcoin?.notes !== 40 ||
            result.metadata.name !== "Ada"
          ) {
            throw new Error("timed lookup did not read all 100 notes");
          }
          samples.push(elapsed);
        }
        const summary = summarize(samples);
        const limiter = kindMs >= noteMs && kindMs >= patternMs ? "kind 0 fetch" : noteMs >= patternMs ? "note fetch" : "pattern extract";
        const report = {
          claim: "100 local notes, median under 5s, fail above 20s",
          unit: "ms",
          notes: 100,
          relayQueries: 2,
          runs: samples,
          summary,
          profileMs: { kind0Fetch: kindMs, noteFetch: noteMs, patternExtract: patternMs },
          limiter,
          loadavg: loadavg(),
          cores: availableParallelism(),
          errors: 0,
        };
        mkdirSync("/opt/cursor/artifacts", { recursive: true });
        writeFileSync("/opt/cursor/artifacts/profile-lookup-scan.json", `${JSON.stringify(report, null, 2)}\n`);
        console.log(JSON.stringify(report));
        expect(summary.max, "fail above 20s").toBeLessThan(20_000);
        expect(summary.median, "100 notes stay under 5s on the local relay").toBeLessThan(5_000);
        expect(await (await api.get("/api/items?profileId=demo")).json()).toEqual([]);
        expect(await (await api.get("/api/research?profileId=demo")).json()).toEqual([]);
      } finally {
        close();
      }
    } finally {
      await relay.stop();
    }
  }, 60_000);
});
