import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { InputError, profileId } from "../src/domain/brand.ts";
import { parseResearchRecord } from "../src/domain/research.ts";
import { ResearchStore } from "../src/research/store.ts";

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
