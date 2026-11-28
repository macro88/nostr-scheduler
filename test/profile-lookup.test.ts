import { describe, expect, test } from "vitest";
import { InputError, unixSeconds } from "../src/domain/brand.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";
import {
  classifyPost,
  lookupProfile,
  lookupSubject,
  profileMetadata,
  profilePatterns,
  type LookupPost,
} from "../src/research/profile-lookup.ts";

const mode = { NOSTR_SCHEDULER_MODE: "test" };
const secret = "nsec1notarealkeyxxxxxxxx";

function post(createdAt: number, content: string, type: LookupPost["type"]): LookupPost {
  return { createdAt, content, type };
}

describe("classifyPost", () => {
  test("keeps one type per public post", () => {
    expect(classifyPost({ kind: 1, tags: [], content: "hello there" })).toBe("note");
    expect(classifyPost({ kind: 1, tags: [["e", "ab"]], content: "hello there" })).toBe("reply");
    expect(classifyPost({ kind: 1, tags: [["e", "ab", "", "reply"]], content: "hello there" })).toBe("reply");
    expect(classifyPost({ kind: 1, tags: [["e", "ab", "", "mention"]], content: "hello there" })).toBe("note");
    expect(classifyPost({ kind: 1, tags: [["q", "ab"], ["e", "ab", "", "reply"]], content: "hello there" })).toBe("quote");
    expect(classifyPost({ kind: 6, tags: [["e", "ab"]], content: "" })).toBe("repost");
    expect(classifyPost({ kind: 1, tags: [], content: "   " })).toBeNull();
    expect(classifyPost({ kind: 0, tags: [], content: "{}" })).toBeNull();
  });
});

describe("profilePatterns", () => {
  test("extracts repeated topics and ignores a word that appears once", () => {
    const patterns = profilePatterns([
      post(0, "Bitcoin and lightning keep the lights on", "note"),
      post(86_400, "Bitcoin fees fell again today", "note"),
      post(172_800, "Lightning channels opened overnight", "reply"),
      post(200_000, "A short hello", "note"),
    ]);
    expect(patterns.pillars).toEqual([
      { label: "bitcoin", notes: 2 },
      { label: "lightning", notes: 2 },
    ]);
    expect(patterns.mix).toEqual({ note: 3, reply: 1, quote: 0, repost: 0 });
    expect(patterns.cadence).toEqual({
      posts: 4,
      windowSeconds: 200_000,
      postsPerWeek: (4 * 604_800) / 200_000,
      medianGapSeconds: 86_400,
    });
  });

  test("counts a word once per note and drops urls, stopwords, and repost text", () => {
    const patterns = profilePatterns([
      post(0, "https://bitcoin.org/a https://bitcoin.org/b", "note"),
      post(10, "https://bitcoin.org/c", "note"),
      post(20, "orange marmalade", "note"),
      post(30, "orange marmalade bitcoin bitcoin", "quote"),
      post(40, "bitcoin should stay inside the repost", "repost"),
    ]);
    expect(patterns.pillars).toEqual([
      { label: "marmalade", notes: 2 },
      { label: "orange", notes: 2 },
    ]);
    expect(patterns.mix.repost).toBe(1);
    expect(patterns.cadence.posts).toBe(5);
  });

  test("skips topic words in a note that contains a private key", () => {
    const patterns = profilePatterns([
      post(0, `${secret} bitcoin`, "note"),
      post(10, "bitcoin fees", "note"),
    ]);
    expect(patterns.pillars).toEqual([]);
    expect(patterns.cadence.posts).toBe(2);
    expect(JSON.stringify(patterns)).not.toContain(secret);
  });

  test("has no weekly rate for one post or one timestamp", () => {
    expect(profilePatterns([post(50, "only bitcoin here", "note")]).cadence).toEqual({
      posts: 1,
      windowSeconds: 0,
      postsPerWeek: null,
      medianGapSeconds: null,
    });
    expect(
      profilePatterns([post(50, "bitcoin one", "note"), post(50, "bitcoin two", "note")]).cadence,
    ).toMatchObject({ posts: 2, windowSeconds: 0, postsPerWeek: null, medianGapSeconds: null });
  });
});

describe("profileMetadata", () => {
  test("prefers display name and clips a long about", () => {
    const about = "x".repeat(300);
    expect(profileMetadata(JSON.stringify({ name: "ada", display_name: " Ada Lovelace ", about }))).toEqual({
      name: "Ada Lovelace",
      about: "x".repeat(280),
    });
    expect(profileMetadata("not json")).toEqual({ name: null, about: null });
    expect(profileMetadata(JSON.stringify({ name: "  ", about: "" }))).toEqual({ name: null, about: null });
  });
});

describe("lookupProfile", () => {
  test("an empty relay list does not read", async () => {
    const signer = createMockSigner(mode);
    const report = await lookupProfile({
      npub: signer.npub,
      pubkey: signer.pubkey,
      relays: [],
      now: unixSeconds(1_700_000_000),
    });
    expect(report.relayQueries).toBe(0);
    expect(report.cadence.posts).toBe(0);
    expect(report.metadata).toEqual({ name: null, about: null });
    expect(report.pillars).toEqual([]);
  });
});

describe("lookupSubject", () => {
  test("accepts a lowercase or uppercase npub and rejects other pasted values", () => {
    const signer = createMockSigner(mode);
    expect(lookupSubject(`  ${signer.npub}  `)).toEqual({ npub: signer.npub, pubkey: signer.pubkey });
    expect(lookupSubject(signer.npub.toUpperCase())).toEqual({ npub: signer.npub, pubkey: signer.pubkey });
    expect(() => lookupSubject(signer.pubkey)).toThrow(InputError);
    expect(() => lookupSubject("npub1notakey")).toThrow(InputError);
    expect(() => lookupSubject(secret)).toThrow(InputError);
    try {
      lookupSubject(secret);
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      expect(error instanceof Error ? error.message : "").not.toContain(secret);
    }
  });
});
