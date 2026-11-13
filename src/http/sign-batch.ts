import { InputError, unixSeconds, type UnixSeconds } from "../domain/brand.ts";
import {
  assertSamePayload,
  nextThreadUnsigned,
  noteUnsigned,
  parseSignedEvent,
  replyUnsigned,
  threadPlanFromDraft,
} from "../domain/event.ts";
import { assertWithinSignHorizon } from "../domain/horizon.ts";
import { signAheadSeconds } from "../domain/defaults.ts";
import { assertNoPrivateKey } from "../domain/private-key.ts";
import type { Approved, Profile, SignedEvent, UnsignedEvent, WorkItem } from "../domain/types.ts";

export type SignCursor = {
  profileId: string;
  pending: Map<string, SignedEvent[]>;
  current: { itemId: string; unsigned: UnsignedEvent } | null;
};

export function blankCursor(profileId: string): SignCursor {
  return { profileId, pending: new Map(), current: null };
}

export function nextUnsigned(args: {
  item: Approved;
  profile: Profile;
  signedSoFar: readonly SignedEvent[];
  now: UnixSeconds;
}): UnsignedEvent | null {
  assertNoPrivateKey(args.item.draft);
  const relayHint = args.profile.relays.configured[0];
  if (args.item.draft.type !== "note" && !relayHint) throw new InputError("relays", "add a relay before signing");
  const check = (createdAt: UnixSeconds) =>
    assertWithinSignHorizon({ now: args.now, createdAt, maxAheadSeconds: signAheadSeconds() });
  if (args.item.draft.type === "note") {
    if (args.signedSoFar.length > 0) return null;
    const unsigned = noteUnsigned({
      pubkey: args.profile.pubkey,
      content: args.item.draft.content,
      createdAt: args.item.draft.proposedFireAt,
    });
    check(unsigned.created_at);
    return unsigned;
  }
  if (args.item.draft.type === "reply") {
    if (args.signedSoFar.length > 0) return null;
    if (!relayHint) throw new InputError("relays", "add a relay before signing");
    const unsigned = replyUnsigned({ pubkey: args.profile.pubkey, draft: args.item.draft, relayHint });
    check(unsigned.created_at);
    return unsigned;
  }
  if (!relayHint) throw new InputError("relays", "add a relay before signing");
  const plan = threadPlanFromDraft({ pubkey: args.profile.pubkey, draft: args.item.draft, relayHint });
  if (args.signedSoFar.length === 0) {
    check(plan.root.created_at);
    for (const reply of plan.replyDrafts) check(reply.created_at);
    return plan.root;
  }
  if (args.signedSoFar.length > plan.replyDrafts.length) return null;
  const [root, ...rest] = args.signedSoFar;
  if (!root) return null;
  return nextThreadUnsigned({ plan, signedSoFar: [root, ...rest] });
}

export function acceptSigned(unsigned: UnsignedEvent, value: unknown, pubkey: string): SignedEvent {
  const signed = parseSignedEvent(value);
  assertSamePayload(unsigned, signed);
  if (signed.pubkey !== pubkey) throw new Error("signed pubkey does not match the profile");
  return signed;
}

export function fireTimes(item: WorkItem): number[] {
  if (item.status === "discarded") return [];
  if (item.status === "suggestion" || item.status === "approved" || item.status === "rejected") {
    if (item.draft.type === "thread") return item.draft.segments.map((segment) => segment.proposedFireAt);
    return [item.draft.proposedFireAt];
  }
  return item.events.map((event) => event.created_at);
}

export function previewOf(item: WorkItem): string {
  if (item.status === "discarded") return item.reason;
  if (item.status === "suggestion" || item.status === "approved" || item.status === "rejected") {
    if (item.draft.type === "thread") return item.draft.segments.map((segment) => segment.content).join("\n");
    return item.draft.content;
  }
  return item.events.map((event) => event.content).join("\n");
}

export function shiftDraft(item: Extract<WorkItem, { draft: unknown }>, fireAt: number) {
  if (item.status !== "suggestion" && item.status !== "approved" && item.status !== "rejected") {
    throw new Error("only an unsigned item can move");
  }
  const draft = item.draft;
  if (draft.type !== "thread") return { ...draft, proposedFireAt: unixSeconds(fireAt) };
  const first = draft.segments[0].proposedFireAt;
  const delta = fireAt - first;
  const segments = draft.segments.map((segment) => ({
    content: segment.content,
    proposedFireAt: unixSeconds(segment.proposedFireAt + delta),
  }));
  const [a, b, ...rest] = segments;
  if (!a || !b) throw new Error("a thread needs a root and a reply");
  return { type: "thread" as const, segments: [a, b, ...rest] as const };
}
