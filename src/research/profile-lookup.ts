import { InputError, npub, unixSeconds, type HexPubkey, type Npub, type RelayUrl, type UnixSeconds } from "../domain/brand.ts";
import { npubFromPubkey, pubkeyFromNpub } from "../domain/bech32.ts";
import type { RawEvent } from "../domain/event.ts";
import { containsPrivateKey } from "../domain/private-key.ts";
import { loadAuthorEvents, type RelayQueries } from "./public-notes.ts";

export const PROFILE_LOOKUP_LIMIT = 100;
export const PILLAR_LIMIT = 5;
export const PILLAR_MIN_NOTES = 2;

const WEEK_SECONDS = 604_800;
const NAME_LIMIT = 80;
const ABOUT_LIMIT = 280;
const KIND0_LIMIT = 20;

const STOP = new Set([
  "that",
  "this",
  "with",
  "from",
  "have",
  "your",
  "just",
  "about",
  "they",
  "them",
  "their",
  "what",
  "when",
  "where",
  "which",
  "will",
  "would",
  "could",
  "should",
  "there",
  "here",
  "been",
  "were",
  "into",
  "than",
  "then",
  "also",
  "some",
  "more",
  "only",
  "over",
  "such",
  "like",
  "make",
  "made",
  "does",
  "doing",
  "done",
  "these",
  "those",
  "much",
  "many",
  "most",
  "very",
  "really",
  "still",
  "even",
  "back",
  "well",
  "because",
  "while",
  "after",
  "before",
  "through",
  "under",
  "again",
  "today",
  "http",
  "https",
  "www",
  "nostr",
  "note",
  "post",
  "posts",
  "people",
  "thing",
  "things",
  "something",
  "please",
  "thanks",
  "thank",
  "going",
  "want",
  "need",
  "know",
  "think",
]);

export type PostType = "note" | "reply" | "quote" | "repost";

export type LookupPost = {
  readonly createdAt: number;
  readonly content: string;
  readonly type: PostType;
};

export type ProfileMetadata = {
  readonly name: string | null;
  readonly about: string | null;
};

export type Cadence = {
  readonly posts: number;
  readonly spanSeconds: number;
  readonly postsPerWeek: number | null;
  readonly medianGapSeconds: number | null;
};

export type PostTypeMix = {
  readonly note: number;
  readonly reply: number;
  readonly quote: number;
  readonly repost: number;
};

export type TopicPillar = {
  readonly label: string;
  readonly notes: number;
};

export type ProfilePatterns = {
  readonly cadence: Cadence;
  readonly mix: PostTypeMix;
  readonly pillars: readonly TopicPillar[];
};

export type ProfileLookup = {
  readonly npub: Npub;
  readonly pubkey: HexPubkey;
  readonly metadata: ProfileMetadata;
  readonly cadence: Cadence;
  readonly mix: PostTypeMix;
  readonly pillars: readonly TopicPillar[];
  readonly relayQueries: number;
  readonly lookedUpAt: UnixSeconds;
};

const TOKEN = /[a-z][a-z0-9]{3,23}/g;

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clip(value: string, limit: number): string | null {
  if (value.length === 0) return null;
  return value.length <= limit ? value : value.slice(0, limit);
}

export function profileMetadata(content: string): ProfileMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { name: null, about: null };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { name: null, about: null };
  const record = parsed as Record<string, unknown>;
  return {
    name: clip(textField(record.display_name) || textField(record.name), NAME_LIMIT),
    about: clip(textField(record.about), ABOUT_LIMIT),
  };
}

export function classifyPost(event: {
  kind: number;
  tags: readonly (readonly string[])[];
  content: string;
}): PostType | null {
  if (event.kind === 6) return "repost";
  if (event.kind !== 1 || event.content.trim().length === 0) return null;
  if (event.tags.some((tag) => tag[0] === "q" && (tag[1]?.length ?? 0) > 0)) return "quote";
  const reply = event.tags.some((tag) => tag[0] === "e" && (tag[1]?.length ?? 0) > 0 && tag[3] !== "mention");
  return reply ? "reply" : "note";
}

function tokensOf(content: string): Set<string> {
  const stripped = content
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/nostr:[a-z0-9]+/g, " ");
  const found = stripped.match(TOKEN) ?? [];
  return new Set(found.filter((word) => !STOP.has(word)));
}

function pillarsOf(posts: readonly LookupPost[]): TopicPillar[] {
  const counts = new Map<string, number>();
  for (const post of posts) {
    if (post.type === "repost" || containsPrivateKey(post.content)) continue;
    for (const token of tokensOf(post.content)) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter((entry) => entry[1] >= PILLAR_MIN_NOTES)
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .slice(0, PILLAR_LIMIT)
    .map(([label, notes]) => ({ label, notes }));
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const mid = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[mid] ?? null;
  const left = ordered[mid - 1];
  const right = ordered[mid];
  if (left === undefined || right === undefined) return null;
  return (left + right) / 2;
}

export function profilePatterns(posts: readonly LookupPost[]): ProfilePatterns {
  const mix = { note: 0, reply: 0, quote: 0, repost: 0 };
  const times: number[] = [];
  for (const post of posts) {
    mix[post.type] += 1;
    times.push(post.createdAt);
  }
  times.sort((left, right) => left - right);
  const first = times[0];
  const last = times[times.length - 1];
  const spanSeconds = first === undefined || last === undefined || times.length < 2 ? 0 : last - first;
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const previous = times[index - 1];
    const next = times[index];
    if (previous === undefined || next === undefined) continue;
    gaps.push(next - previous);
  }
  const rated = times.length >= 2 && spanSeconds > 0;
  return {
    cadence: {
      posts: times.length,
      spanSeconds,
      postsPerWeek: rated ? (times.length * WEEK_SECONDS) / spanSeconds : null,
      medianGapSeconds: rated ? median(gaps) : null,
    },
    mix,
    pillars: pillarsOf(posts),
  };
}

export function lookupSubject(value: string): { npub: Npub; pubkey: HexPubkey } {
  const trimmed = value.trim();
  if (trimmed.length === 0 || containsPrivateKey(trimmed)) throw new InputError("npub", "Paste a public npub.");
  const normalized = trimmed === trimmed.toUpperCase() ? trimmed.toLowerCase() : trimmed;
  try {
    const pubkey = pubkeyFromNpub(npub(normalized));
    return { npub: npubFromPubkey(pubkey), pubkey };
  } catch {
    throw new InputError("npub", "Paste a public npub.");
  }
}

function postsOf(events: readonly RawEvent[], author: HexPubkey): LookupPost[] {
  const posts: LookupPost[] = [];
  for (const event of events) {
    if (event.pubkey !== author) continue;
    const type = classifyPost(event);
    if (!type) continue;
    posts.push({ createdAt: event.created_at, content: event.content, type });
  }
  return posts;
}

function emptyLookup(args: { npub: Npub; pubkey: HexPubkey; now: UnixSeconds }): ProfileLookup {
  const patterns = profilePatterns([]);
  return {
    npub: args.npub,
    pubkey: args.pubkey,
    metadata: { name: null, about: null },
    cadence: patterns.cadence,
    mix: patterns.mix,
    pillars: patterns.pillars,
    relayQueries: 0,
    lookedUpAt: args.now,
  };
}

export async function lookupProfile(args: {
  npub: Npub;
  pubkey: HexPubkey;
  relays: readonly RelayUrl[];
  now: UnixSeconds;
}): Promise<ProfileLookup> {
  if (args.relays.length === 0) return emptyLookup(args);
  const queries: RelayQueries = { count: 0 };
  let card: RawEvent[];
  let events: RawEvent[];
  try {
    card = await loadAuthorEvents(args.pubkey, args.relays, queries, [0], KIND0_LIMIT);
    events = await loadAuthorEvents(args.pubkey, args.relays, queries, [1, 6], PROFILE_LOOKUP_LIMIT);
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("relays", "The relays did not answer.");
  }
  const patterns = profilePatterns(postsOf(events, args.pubkey));
  return {
    npub: args.npub,
    pubkey: args.pubkey,
    metadata: profileMetadata(card[0]?.content ?? ""),
    cadence: patterns.cadence,
    mix: patterns.mix,
    pillars: patterns.pillars,
    relayQueries: queries.count,
    lookedUpAt: unixSeconds(args.now),
  };
}
