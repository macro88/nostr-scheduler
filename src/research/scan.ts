import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { researchId, type EventId, type HexPubkey, type ProfileId, type RelayUrl, type ResearchId, type UnixSeconds } from "../domain/brand.ts";
import { parseRawEvent, type RawEvent } from "../domain/event.ts";
import type { OutlierHit, OutlierSignals } from "../domain/research.ts";
import { fetchFromRelay } from "../test-relay/client.ts";
import { engagementOf, scoreOutlier } from "./score.ts";
import type { ResearchStore } from "./store.ts";

const NOTE_LIMIT = 50;
const MIN_MULTIPLIER = 2;

const SIGNAL_KIND = {
  1: "replies",
  6: "reposts",
  7: "reactions",
  9735: "zaps",
} as const;

type SignalKind = keyof typeof SIGNAL_KIND;
type Tally = Record<(typeof SIGNAL_KIND)[SignalKind], number>;

export type OutlierScan = {
  readonly authors: number;
  readonly notes: number;
  readonly relayQueries: number;
  readonly hits: readonly OutlierHit[];
};

function signalKinds(): number[] {
  return Object.keys(SIGNAL_KIND).map((key) => Number(key));
}

function isSignalKind(kind: number): kind is SignalKind {
  return Object.hasOwn(SIGNAL_KIND, kind);
}

function emptyTally(): Tally {
  return { replies: 0, reposts: 0, reactions: 0, zaps: 0 };
}

function meanExcluding(values: readonly number[], skip: number): number {
  let sum = 0;
  let count = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (index === skip) continue;
    sum += values[index] ?? 0;
    count += 1;
  }
  if (count === 0) return 0;
  return sum / count;
}

function outlierResearchId(profile: ProfileId, event: EventId): ResearchId {
  const digest = bytesToHex(sha256(new TextEncoder().encode(`${profile}\0${event}`)));
  return researchId(`res_${digest.slice(0, 16)}`);
}

async function readMerged(
  relays: readonly RelayUrl[],
  filter: Record<string, unknown>,
  queries: { count: number },
): Promise<Map<string, RawEvent>> {
  const merged = new Map<string, RawEvent>();
  let ok = 0;
  let failure: Error | undefined;
  for (const relay of relays) {
    queries.count += 1;
    try {
      const rows = await fetchFromRelay(relay, filter, { strict: true });
      ok += 1;
      for (const row of rows) {
        try {
          const event = parseRawEvent(row);
          if (!merged.has(event.id)) merged.set(event.id, event);
        } catch {
          continue;
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error("relay read failed");
    }
  }
  if (ok === 0) throw failure ?? new Error("relay read failed");
  return merged;
}

async function loadNotes(
  author: HexPubkey,
  relays: readonly RelayUrl[],
  queries: { count: number },
): Promise<RawEvent[]> {
  const merged = await readMerged(relays, { kinds: [1], authors: [author], limit: NOTE_LIMIT }, queries);
  return [...merged.values()]
    .filter((event) => event.kind === 1 && event.pubkey === author && event.content.trim().length > 0)
    .sort((left, right) => right.created_at - left.created_at || (left.id < right.id ? -1 : 1))
    .slice(0, NOTE_LIMIT);
}

async function loadTallies(
  notes: readonly RawEvent[],
  relays: readonly RelayUrl[],
  queries: { count: number },
): Promise<Map<string, Tally>> {
  const counts = new Map<string, Tally>();
  for (const note of notes) counts.set(note.id, emptyTally());
  if (notes.length === 0) return counts;
  const ids = notes.map((note) => note.id);
  const events = await readMerged(relays, { kinds: signalKinds(), "#e": ids }, queries);
  const noteIds = new Set<string>(ids);
  for (const event of events.values()) {
    if (!isSignalKind(event.kind)) continue;
    const field = SIGNAL_KIND[event.kind];
    const tagged = new Set<string>();
    for (const tag of event.tags) {
      const target = tag[1];
      if (tag[0] !== "e" || target === undefined || target === event.id || !noteIds.has(target)) continue;
      tagged.add(target);
    }
    for (const target of tagged) {
      const tally = counts.get(target);
      if (!tally) continue;
      tally[field] += 1;
    }
  }
  return counts;
}

function signalsOf(tally: Tally): OutlierSignals {
  return {
    replies: tally.replies,
    reposts: tally.reposts,
    reactions: tally.reactions,
    zaps: tally.zaps,
  };
}

export async function scanOutliers(args: {
  profileId: ProfileId;
  authors: readonly HexPubkey[];
  relays: readonly RelayUrl[];
  store: ResearchStore;
  now: UnixSeconds;
}): Promise<OutlierScan> {
  const authors: HexPubkey[] = [];
  const seen = new Set<string>();
  for (const author of args.authors) {
    if (seen.has(author)) continue;
    seen.add(author);
    authors.push(author);
  }
  if (args.relays.length === 0) {
    return { authors: authors.length, notes: 0, relayQueries: 0, hits: [] };
  }
  const queries = { count: 0 };
  const hits: OutlierHit[] = [];
  let notes = 0;
  for (const author of authors) {
    const window = await loadNotes(author, args.relays, queries);
    notes += window.length;
    const tallies = await loadTallies(window, args.relays, queries);
    const engagements = window.map((note) => engagementOf(signalsOf(tallies.get(note.id) ?? emptyTally())));
    for (let index = 0; index < window.length; index += 1) {
      const note = window[index];
      if (!note) continue;
      const signals = signalsOf(tallies.get(note.id) ?? emptyTally());
      const postEngagement = engagements[index] ?? 0;
      const baseline = meanExcluding(engagements, index);
      const multiplier = scoreOutlier({ baselineEngagement: baseline, postEngagement });
      if (multiplier < MIN_MULTIPLIER) continue;
      hits.push({
        kind: "outlier",
        id: outlierResearchId(args.profileId, note.id),
        profileId: args.profileId,
        authorPubkey: note.pubkey,
        eventId: note.id,
        content: note.content,
        multiplier,
        baseline,
        signals,
        createdAt: note.created_at,
        scannedAt: args.now,
      });
    }
  }
  for (const hit of hits) args.store.put(hit);
  const kept = new Set(hits.map((hit) => hit.id));
  for (const row of args.store.list(args.profileId)) {
    if (row.kind === "outlier" && !kept.has(row.id)) args.store.delete(row.id);
  }
  return { authors: authors.length, notes, relayQueries: queries.count, hits };
}
