import { InputError, type HexPubkey, type RelayUrl, type UnixSeconds } from "../domain/brand.ts";
import type { OutlierSignals } from "../domain/research.ts";
import { emptyTally, loadAuthorNotes, loadSignalTallies, PERFORMANCE_NOTE_LIMIT, signalsOf, type RelayQueries } from "./public-notes.ts";
import { engagementOf, meanExcluding, scoreOutlier } from "./score.ts";

export const PERFORMANCE_BAND_FRACTION = 0.2;

export type PerformanceLabel = "Do more" | "Do less";

export type PerformanceRank = {
  readonly eventId: string;
  readonly createdAt: number;
  readonly multiplier: number;
};

type BandFields =
  | { readonly band: "top"; readonly label: "Do more" }
  | { readonly band: "bottom"; readonly label: "Do less" }
  | { readonly band: "middle"; readonly label: null };

export type Banded<T> = T & BandFields;

export type PerformanceBands<T> = {
  readonly fraction: typeof PERFORMANCE_BAND_FRACTION;
  readonly topCutoff: number | null;
  readonly bottomCutoff: number | null;
  readonly notes: readonly Banded<T>[];
};

export type ScoredNote = {
  readonly eventId: string;
  readonly content: string;
  readonly createdAt: UnixSeconds;
  readonly signals: OutlierSignals;
  readonly engagement: number;
  readonly baseline: number;
  readonly multiplier: number;
};

export type PerformanceNote = Banded<ScoredNote>;

export type PerformanceReport = {
  readonly pubkey: HexPubkey;
  readonly fraction: typeof PERFORMANCE_BAND_FRACTION;
  readonly topCutoff: number | null;
  readonly bottomCutoff: number | null;
  readonly notes: readonly PerformanceNote[];
  readonly relayQueries: number;
  readonly scannedAt: UnixSeconds;
};

function byRank(left: PerformanceRank, right: PerformanceRank): number {
  if (left.multiplier !== right.multiplier) return right.multiplier - left.multiplier;
  if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
  if (left.eventId < right.eventId) return -1;
  if (left.eventId > right.eventId) return 1;
  return 0;
}

export function assignPerformanceBands<T extends PerformanceRank>(notes: readonly T[]): PerformanceBands<T> {
  for (const note of notes) {
    if (!Number.isFinite(note.multiplier) || note.multiplier < 0) {
      throw new InputError("multiplier", "expected a non-negative finite number");
    }
  }
  const ranked = [...notes].sort(byRank);
  const size = Math.floor(ranked.length * PERFORMANCE_BAND_FRACTION);
  const bandOf = ranked.map(() => "middle" as "top" | "bottom" | "middle");
  for (let index = 0; index < size; index += 1) bandOf[index] = "top";
  for (let index = ranked.length - size; index < ranked.length; index += 1) bandOf[index] = "bottom";
  const topCutoff = size === 0 ? null : (ranked[size - 1]?.multiplier ?? null);
  const bottomCutoff = size === 0 ? null : (ranked[ranked.length - size]?.multiplier ?? null);
  const banded = ranked.map((note, index) => {
    const band = bandOf[index] ?? "middle";
    if (band === "top") return { ...note, band, label: "Do more" as const };
    if (band === "bottom") return { ...note, band, label: "Do less" as const };
    return { ...note, band: "middle" as const, label: null };
  });
  return { fraction: PERFORMANCE_BAND_FRACTION, topCutoff, bottomCutoff, notes: banded };
}

function emptyReport(pubkey: HexPubkey, now: UnixSeconds, relayQueries: number): PerformanceReport {
  return {
    pubkey,
    fraction: PERFORMANCE_BAND_FRACTION,
    topCutoff: null,
    bottomCutoff: null,
    notes: [],
    relayQueries,
    scannedAt: now,
  };
}

export async function scanPerformance(args: {
  pubkey: HexPubkey;
  relays: readonly RelayUrl[];
  now: UnixSeconds;
}): Promise<PerformanceReport> {
  if (args.relays.length === 0) return emptyReport(args.pubkey, args.now, 0);
  const queries: RelayQueries = { count: 0 };
  const window = await loadAuthorNotes(args.pubkey, args.relays, queries, PERFORMANCE_NOTE_LIMIT);
  const tallies = await loadSignalTallies(window, args.relays, queries);
  const engagements = window.map((note) => engagementOf(signalsOf(tallies.get(note.id) ?? emptyTally())));
  const scored: ScoredNote[] = window.map((note, index) => {
    const signals = signalsOf(tallies.get(note.id) ?? emptyTally());
    const engagement = engagements[index] ?? 0;
    const baseline = meanExcluding(engagements, index);
    return {
      eventId: note.id,
      content: note.content,
      createdAt: note.created_at,
      signals,
      engagement,
      baseline,
      multiplier: scoreOutlier({ baselineEngagement: baseline, postEngagement: engagement }),
    };
  });
  const bands = assignPerformanceBands(scored);
  return {
    pubkey: args.pubkey,
    fraction: bands.fraction,
    topCutoff: bands.topCutoff,
    bottomCutoff: bands.bottomCutoff,
    notes: bands.notes,
    relayQueries: queries.count,
    scannedAt: args.now,
  };
}
