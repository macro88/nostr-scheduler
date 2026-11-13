import { nonEmpty, unixSeconds, type UnixSeconds } from "../domain/brand.ts";
import { decideCatchUp } from "../domain/catchup.ts";
import { parseRawEvent } from "../domain/event.ts";
import { classifyPublishRelay, mergeWriteRelays, relayListFromTags } from "../domain/relays.ts";
import type { PerRelayResult, Profile, Queued, RelayUrl, SignedEvent } from "../domain/types.ts";
import { fetchFromRelay } from "../test-relay/client.ts";
import { WorkStore } from "../work/store.ts";

export type RelayTransport = {
  publish(relay: RelayUrl, event: SignedEvent): Promise<PerRelayResult>;
};

export const RETRY_DELAYS_SECONDS = [1, 2, 4, 8, 16] as const;

async function publishEvent(args: {
  transport: RelayTransport;
  relays: readonly RelayUrl[];
  event: SignedEvent;
  now: () => UnixSeconds;
  windowEnd: number;
  sleep: (seconds: number) => Promise<void>;
  delays: readonly number[];
  store: WorkStore;
  suggestionId: Queued["id"];
}): Promise<boolean> {
  let pending = [...args.relays];
  let attempt = 0;
  let accepted = args.store.hasAccept(args.suggestionId, args.event.id);
  while (pending.length > 0 && args.now() <= args.windowEnd) {
    const still: RelayUrl[] = [];
    for (const relay of pending) {
      if (args.now() > args.windowEnd) break;
      const result = await args.transport.publish(relay, args.event);
      args.store.recordPublish({
        suggestionId: args.suggestionId,
        eventId: args.event.id,
        relay,
        accepted: result.accepted,
        message: result.message,
        at: args.now(),
      });
      if (result.accepted) accepted = true;
      else still.push(relay);
    }
    pending = still;
    if (pending.length === 0) break;
    const delay = args.delays[attempt];
    if (delay === undefined) break;
    if (args.now() + delay > args.windowEnd) break;
    await args.sleep(delay);
    attempt += 1;
  }
  return accepted;
}

export async function publishDue(args: {
  store: WorkStore;
  profiles: readonly Profile[];
  transport: RelayTransport;
  now: () => UnixSeconds;
  windowSeconds: number;
  sleep?: (seconds: number) => Promise<void>;
  delays?: readonly number[];
}): Promise<{ sent: number; failed: number; missed: number; waiting: number }> {
  const sleep = args.sleep ?? ((seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)));
  const delays = args.delays ?? RETRY_DELAYS_SECONDS;
  const profiles = new Map(args.profiles.map((profile) => [profile.id, profile]));
  const summary = { sent: 0, failed: 0, missed: 0, waiting: 0 };
  for (const item of args.store.list()) {
    if (item.status !== "queued") continue;
    const profile = profiles.get(item.profileId);
    if (!profile) continue;
    const outcome = await publishItem({
      item,
      profile,
      store: args.store,
      transport: args.transport,
      now: args.now,
      windowSeconds: args.windowSeconds,
      sleep,
      delays,
    });
    summary[outcome] += 1;
  }
  return summary;
}

async function publishItem(args: {
  item: Queued;
  profile: Profile;
  store: WorkStore;
  transport: RelayTransport;
  now: () => UnixSeconds;
  windowSeconds: number;
  sleep: (seconds: number) => Promise<void>;
  delays: readonly number[];
}): Promise<"sent" | "failed" | "missed" | "waiting"> {
  for (const event of args.item.events) {
    if (args.store.hasAccept(args.item.id, event.id)) continue;
    const decision = decideCatchUp({
      now: args.now(),
      createdAt: event.created_at,
      windowSeconds: args.windowSeconds,
    });
    if (decision.action === "wait") return "waiting";
    if (decision.action === "missed") {
      args.store.transition(
        args.item.id,
        { type: "missed", lateBySeconds: decision.lateBySeconds },
        args.now(),
        args.profile,
      );
      return "missed";
    }
    const accepted = await publishEvent({
      transport: args.transport,
      relays: await targetRelays(args.profile),
      event,
      now: args.now,
      windowEnd: event.created_at + args.windowSeconds,
      sleep: args.sleep,
      delays: args.delays,
      store: args.store,
      suggestionId: args.item.id,
    });
    if (!accepted) {
      const results = args.store.resultsFor(args.item.id).filter((result) => !result.accepted);
      args.store.transition(
        args.item.id,
        { type: "failed", results, reason: "no relay accepted the event" },
        args.now(),
        args.profile,
      );
      return "failed";
    }
  }
  const results = nonEmpty(args.store.resultsFor(args.item.id), "results");
  args.store.transition(args.item.id, { type: "sent", results }, args.now(), args.profile);
  return "sent";
}

export function virtualClock(start: number): { now: () => UnixSeconds; advance: (seconds: number) => void } {
  let current = start;
  return {
    now: () => unixSeconds(current),
    advance(seconds: number) {
      current += seconds;
    },
  };
}

function usableRelays(urls: readonly string[], allowPublicRelays: boolean): RelayUrl[] {
  const usable: RelayUrl[] = [];
  for (const url of urls) {
    const decision = classifyPublishRelay(url, allowPublicRelays);
    if (decision.publish) usable.push(decision.url);
  }
  return usable;
}

async function targetRelays(profile: Profile): Promise<readonly RelayUrl[]> {
  if (!profile.relays.readNip65) return profile.relays.configured;
  const first = profile.relays.configured[0];
  if (!first) return profile.relays.configured;
  try {
    const rows = await fetchFromRelay(first, { authors: [profile.pubkey], kinds: [10002], limit: 1 });
    const raw = parseRawEvent(rows[0]);
    if (raw.kind !== 10002) return profile.relays.configured;
    const merged = mergeWriteRelays(profile.relays.configured, relayListFromTags(raw.tags), true);
    const allowed = usableRelays(merged, profile.relays.allowPublicRelays);
    return allowed.length > 0 ? allowed : profile.relays.configured;
  } catch {
    return profile.relays.configured;
  }
}
