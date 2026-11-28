import type { HexPubkey, RelayUrl } from "../domain/brand.ts";
import { parseRawEvent, type RawEvent } from "../domain/event.ts";
import type { OutlierSignals } from "../domain/research.ts";
import { fetchFromRelay } from "../test-relay/client.ts";

export const OUTLIER_NOTE_LIMIT = 50;
export const PERFORMANCE_NOTE_LIMIT = 100;

const SIGNAL_KIND = {
  1: "replies",
  6: "reposts",
  7: "reactions",
  9735: "zaps",
} as const;

type SignalKind = keyof typeof SIGNAL_KIND;

export type SignalTally = Record<(typeof SIGNAL_KIND)[SignalKind], number>;

export type RelayQueries = { count: number };

function signalKinds(): number[] {
  return Object.keys(SIGNAL_KIND).map((key) => Number(key));
}

function isSignalKind(kind: number): kind is SignalKind {
  return Object.hasOwn(SIGNAL_KIND, kind);
}

export function emptyTally(): SignalTally {
  return { replies: 0, reposts: 0, reactions: 0, zaps: 0 };
}

async function readPublicEvents(
  relays: readonly RelayUrl[],
  filter: Record<string, unknown>,
  queries: RelayQueries,
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

function byNewest(left: RawEvent, right: RawEvent): number {
  return right.created_at - left.created_at || (left.id < right.id ? -1 : 1);
}

function newest(events: Iterable<RawEvent>, accept: (event: RawEvent) => boolean, limit: number): RawEvent[] {
  return [...events].filter(accept).sort(byNewest).slice(0, limit);
}

export async function loadAuthorNotes(
  author: HexPubkey,
  relays: readonly RelayUrl[],
  queries: RelayQueries,
  limit: number,
): Promise<RawEvent[]> {
  const merged = await readPublicEvents(relays, { kinds: [1], authors: [author], limit }, queries);
  return newest(
    merged.values(),
    (event) => event.kind === 1 && event.pubkey === author && event.content.trim().length > 0,
    limit,
  );
}

export async function loadAuthorEvents(
  author: HexPubkey,
  relays: readonly RelayUrl[],
  queries: RelayQueries,
  kinds: readonly number[],
  limit: number,
): Promise<RawEvent[]> {
  const allowed = new Set(kinds);
  const merged = await readPublicEvents(relays, { kinds: [...allowed], authors: [author], limit }, queries);
  return newest(merged.values(), (event) => allowed.has(event.kind) && event.pubkey === author, limit);
}

export async function loadSignalTallies(
  notes: readonly RawEvent[],
  relays: readonly RelayUrl[],
  queries: RelayQueries,
): Promise<Map<string, SignalTally>> {
  const counts = new Map<string, SignalTally>();
  for (const note of notes) counts.set(note.id, emptyTally());
  if (notes.length === 0) return counts;
  const ids = notes.map((note) => note.id);
  const events = await readPublicEvents(relays, { kinds: signalKinds(), "#e": ids }, queries);
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

export function signalsOf(tally: SignalTally): OutlierSignals {
  return {
    replies: tally.replies,
    reposts: tally.reposts,
    reactions: tally.reactions,
    zaps: tally.zaps,
  };
}
