import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { researchId, type EventId, type HexPubkey, type ProfileId, type RelayUrl, type ResearchId, type UnixSeconds } from "../domain/brand.ts";
import type { OutlierHit } from "../domain/research.ts";
import { emptyTally, loadAuthorNotes, loadSignalTallies, OUTLIER_NOTE_LIMIT, signalsOf } from "./public-notes.ts";
import { engagementOf, meanExcluding, scoreOutlier } from "./score.ts";
import type { ResearchStore } from "./store.ts";

const MIN_MULTIPLIER = 2;

export type OutlierScan = {
  readonly authors: number;
  readonly notes: number;
  readonly relayQueries: number;
  readonly hits: readonly OutlierHit[];
};

function outlierResearchId(profile: ProfileId, event: EventId): ResearchId {
  const digest = bytesToHex(sha256(new TextEncoder().encode(`${profile}\0${event}`)));
  return researchId(`res_${digest.slice(0, 16)}`);
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
    const window = await loadAuthorNotes(author, args.relays, queries, OUTLIER_NOTE_LIMIT);
    notes += window.length;
    const tallies = await loadSignalTallies(window, args.relays, queries);
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
