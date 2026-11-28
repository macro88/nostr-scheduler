import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { InputError, profileId, unixSeconds } from "../src/domain/brand.ts";
import { parseResearchRecord } from "../src/domain/research.ts";
import { createApp } from "../src/http/app.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { ResearchStore } from "../src/research/store.ts";

const example = readFileSync(new URL("../examples/criteria/example-profile.md", import.meta.url), "utf8");

const pubkey = "ab".repeat(32);
const event = "cd".repeat(32);
const createdAt = 1_700_000_000;

function outlier(overrides: Record<string, unknown> = {}) {
  return {
    kind: "outlier",
    id: "res_out01",
    profileId: "demo",
    authorPubkey: pubkey,
    eventId: event,
    content: "a hot note",
    multiplier: 3.5,
    baseline: 2,
    signals: { replies: 4, reposts: 1, reactions: 12, zaps: 0 },
    createdAt,
    scannedAt: createdAt + 60,
    ...overrides,
  };
}

function brief(overrides: Record<string, unknown> = {}) {
  return {
    kind: "brief",
    id: "res_brief01",
    profileId: "demo",
    title: "Morning brief",
    summary: "Five notes worth a look.",
    createdAt,
    ...overrides,
  };
}

function source(overrides: Record<string, unknown> = {}) {
  return {
    kind: "source",
    id: "res_src01",
    profileId: "demo",
    authorPubkey: pubkey,
    eventId: event,
    content: "source text",
    createdAt,
    ...overrides,
  };
}

function rejection(value: unknown): InputError {
  try {
    parseResearchRecord(value);
  } catch (error) {
    if (error instanceof InputError) return error;
    throw error;
  }
  throw new Error("parse accepted an invalid record");
}

describe("parseResearchRecord", () => {
  test("accepts an outlier, a brief, and a source post", () => {
    expect(parseResearchRecord(outlier())).toEqual(outlier());
    expect(parseResearchRecord(brief())).toEqual(brief());
    expect(parseResearchRecord(source())).toEqual(source());
    const withUrl = parseResearchRecord(brief({ url: "https://example.com/brief" }));
    expect(withUrl).toMatchObject({ kind: "brief", url: "https://example.com/brief" });
    const remixed = parseResearchRecord(source({ remixedAt: createdAt + 10 }));
    expect(remixed).toMatchObject({ kind: "source", remixedAt: createdAt + 10 });
  });

  test("omits optional brief url and source remix time when they are absent", () => {
    const parsedBrief = parseResearchRecord(brief());
    const parsedSource = parseResearchRecord(source());
    expect(parsedBrief.kind).toBe("brief");
    expect(parsedSource.kind).toBe("source");
    if (parsedBrief.kind !== "brief" || parsedSource.kind !== "source") return;
    expect(parsedBrief.url).toBeUndefined();
    expect(parsedSource.remixedAt).toBeUndefined();
  });

  test("rejects malformed payloads", () => {
    expect(rejection(null).field).toBe("research");
    expect(rejection([]).field).toBe("research");
    expect(rejection({ status: "draft", id: "sug_demo01" }).field).toBe("kind");
    expect(rejection(outlier({ kind: "hot" })).field).toBe("kind");
    expect(rejection(outlier({ signals: { replies: 1, reposts: 0, reactions: 0 } })).field).toBe("signals.zaps");
    expect(rejection(outlier({ signals: { replies: -1, reposts: 0, reactions: 0, zaps: 0 } })).field).toBe("signals.replies");
    expect(rejection(outlier({ signals: { replies: 1.5, reposts: 0, reactions: 0, zaps: 0 } })).field).toBe("signals.replies");
    expect(rejection(outlier({ authorPubkey: "zz" })).field).toBe("pubkey");
    expect(rejection(outlier({ id: "sug_demo01" })).field).toBe("id");
    expect(rejection(outlier({ multiplier: Number.POSITIVE_INFINITY })).field).toBe("multiplier");
    expect(rejection(brief({ title: "  " })).field).toBe("title");
    expect(rejection(brief({ url: "javascript:alert(1)" })).field).toBe("url");
    expect(rejection(brief({ url: "https://user:pass@example.com/a" })).field).toBe("url");
    expect(rejection(source({ remixedAt: -5 })).field).toBe("remixedAt");
    expect(rejection(source({ extra: true })).field).toBe("extra");
    expect(rejection(outlier({ content: "" })).field).toBe("content");
  });

  test("keeps surrounding spaces in post text", () => {
    const parsed = parseResearchRecord(source({ content: "  keep  " }));
    expect(parsed).toMatchObject({ content: "  keep  " });
  });
});

describe("ResearchStore", () => {
  test("round-trips fixtures and filters by profile", () => {
    const store = new ResearchStore(join(mkdtempSync(join(tmpdir(), "research-")), "research.sqlite"));
    try {
      expect(() => store.insertFixture({ kind: "brief" })).toThrow(InputError);
      expect(store.list()).toEqual([]);
      store.insertFixture(outlier());
      store.insertFixture(brief());
      store.insertFixture(source({ content: "  keep  " }));
      store.insertFixture(brief({ id: "res_brief02", profileId: "other", title: "Other desk" }));
      expect(store.list(profileId("demo"))).toEqual([
        brief(),
        outlier(),
        source({ content: "  keep  " }),
      ]);
      expect(store.list(profileId("other"))).toEqual([
        brief({ id: "res_brief02", profileId: "other", title: "Other desk" }),
      ]);
    } finally {
      store.close();
    }
  });
});

function writeProfile(dir: string, signer: ReturnType<typeof createMockSigner>) {
  const criteria = join(dir, "criteria.md");
  writeFileSync(criteria, example.replace("profile_id: example", "profile_id: demo"));
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
      "      - ws://127.0.0.1:9",
      "    read_nip65: false",
      "    criteria_path: criteria.md",
      "",
    ].join("\n"),
  );
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

describe("GET /api/research", () => {
  test("lists a fixture and leaves /api/items unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "research-http-"));
    writeProfile(dir, createMockSigner());
    const clock = 1_700_000_000;
    const { app, research, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    try {
      const api = await authed(app);
      const missing = await api.get("/api/research?profileId=missing");
      expect(missing.status).toBe(400);
      expect(await (await api.get("/api/research?profileId=demo")).json()).toEqual([]);
      expect(await (await api.get("/api/items?profileId=demo")).json()).toEqual([]);

      research.insertFixture(source());
      expect(await (await api.get("/api/items?profileId=demo")).json()).toEqual([]);
      expect(await (await api.get("/api/research?profileId=demo")).json()).toEqual([source()]);

      const suggested = await api.post("/api/suggestions", {
        profileId: "demo",
        rationale: "because",
        draft: { type: "note", content: "A queued note", proposedFireAt: clock + 30 },
      });
      expect(suggested.status).toBe(200);
      const suggestion = (await suggested.json()) as { id: string };
      const items = (await (await api.get("/api/items?profileId=demo")).json()) as { id: string; preview: string }[];
      const listed = (await (await api.get("/api/research?profileId=demo")).json()) as { id: string; kind: string }[];

      expect(items.map((item) => item.id)).toEqual([suggestion.id]);
      expect(JSON.stringify(items)).not.toContain("res_src01");
      expect(JSON.stringify(items)).not.toContain("source text");
      expect(listed).toEqual([source()]);
      expect(JSON.stringify(listed)).not.toContain(suggestion.id);
    } finally {
      close();
    }
  });
});

function summarize(samples: readonly number[]): { median: number; max: number } {
  const ordered = [...samples].sort((left, right) => left - right);
  return { median: ordered[2] ?? 0, max: ordered[4] ?? 0 };
}

describe("research list timing", () => {
  test("lists 200 stored rows under the sqlite fail line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "research-bench-"));
    writeProfile(dir, createMockSigner());
    const { app, research, close } = createApp({ dataDir: dir, now: () => unixSeconds(createdAt) });
    try {
      for (let index = 0; index < 200; index += 1) {
        research.insertFixture(
          outlier({
            id: `res_${index.toString(16).padStart(4, "0")}`,
            content: `note ${index}`,
          }),
        );
      }
      const warmup = research.list(profileId("demo"));
      expect(warmup).toHaveLength(200);
      const sqlite: number[] = [];
      for (let run = 0; run < 5; run += 1) {
        const start = performance.now();
        const rows = research.list(profileId("demo"));
        const elapsed = performance.now() - start;
        const last = rows.find((row) => row.id === "res_00c7");
        if (rows.length !== 200 || last?.kind !== "outlier" || last.content !== "note 199" || last.signals.replies !== 4) {
          throw new Error("timed list did not return the stored rows");
        }
        sqlite.push(elapsed);
      }
      const http: number[] = [];
      for (let run = 0; run < 5; run += 1) {
        const start = performance.now();
        const response = await app.request("http://127.0.0.1:4173/api/research?profileId=demo", {
          headers: { host: "127.0.0.1:4173" },
        });
        const body: unknown = await response.json();
        const elapsed = performance.now() - start;
        const rows = Array.isArray(body) ? body : [];
        const last = rows.find((row) => typeof row === "object" && row !== null && "id" in row && row.id === "res_00c7");
        const content = typeof last === "object" && last !== null && "content" in last ? last.content : undefined;
        const replies =
          typeof last === "object" && last !== null && "signals" in last && typeof last.signals === "object" && last.signals !== null && "replies" in last.signals
            ? last.signals.replies
            : undefined;
        if (response.status !== 200 || rows.length !== 200 || content !== "note 199" || replies !== 4) {
          throw new Error("timed request did not return the stored rows");
        }
        http.push(elapsed);
      }
      const sqliteSummary = summarize(sqlite);
      const httpSummary = summarize(http);
      console.log(JSON.stringify({ unit: "ms", rows: 200, sqlite, sqliteSummary, http, httpSummary }));
      expect(sqliteSummary.max, "sqlite list of 200 rows must stay under 200 ms").toBeLessThan(200);
      expect(httpSummary.max, "GET /api/research of 200 rows must stay under 200 ms").toBeLessThan(200);
    } finally {
      close();
    }
  });
});
