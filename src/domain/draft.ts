import { eventId, hexPubkey, InputError, relayUrl, unixSeconds, type UnixSeconds } from "./brand.ts";
import { assertNoPrivateKey } from "./private-key.ts";
import type { Draft, ReplyTarget, ThreadSegment } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentOf(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InputError("content", "expected non-empty text");
  }
  return value;
}

function timeOf(value: unknown, field: string): UnixSeconds {
  if (typeof value !== "number") throw new InputError(field, "expected a number");
  return unixSeconds(value);
}

function segmentOf(value: unknown): ThreadSegment {
  if (!isRecord(value)) throw new InputError("segments", "expected an object");
  return { content: contentOf(value.content), proposedFireAt: timeOf(value.proposedFireAt, "proposed_fire_at") };
}

function parentOf(value: unknown): { at: UnixSeconds; content: string } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new InputError("parent", "expected an object");
  return { at: timeOf(value.at, "parent_at"), content: contentOf(value.content) };
}

function targetOf(value: unknown): ReplyTarget {
  if (!isRecord(value)) throw new InputError("target", "expected an object");
  if (typeof value.eventId !== "string" || typeof value.rootId !== "string" || typeof value.pubkey !== "string") {
    throw new InputError("target", "expected eventId, rootId, and pubkey");
  }
  const target: ReplyTarget = {
    eventId: eventId(value.eventId),
    rootId: eventId(value.rootId),
    pubkey: hexPubkey(value.pubkey),
  };
  if (value.relayHint !== undefined) {
    if (typeof value.relayHint !== "string") throw new InputError("relay_hint", "expected a string");
    return { ...target, relayHint: relayUrl(value.relayHint) };
  }
  return target;
}

export function parseDraft(value: unknown): Draft {
  if (!isRecord(value) || typeof value.type !== "string") throw new InputError("draft", "expected a typed draft");
  if (value.type === "note") {
    const draft: Draft = { type: "note", content: contentOf(value.content), proposedFireAt: timeOf(value.proposedFireAt, "proposed_fire_at") };
    assertNoPrivateKey(draft);
    return draft;
  }
  if (value.type === "thread") {
    if (!Array.isArray(value.segments) || value.segments.length < 2) {
      throw new InputError("segments", "a thread needs a root and at least one reply");
    }
    const [first, second, ...rest] = value.segments.map(segmentOf);
    if (first === undefined || second === undefined) {
      throw new InputError("segments", "a thread needs a root and at least one reply");
    }
    const draft: Draft = { type: "thread", segments: [first, second, ...rest] };
    assertNoPrivateKey(draft);
    return draft;
  }
  if (value.type === "reply") {
    const parent = parentOf(value.parent);
    const draft: Draft = {
      type: "reply",
      content: contentOf(value.content),
      proposedFireAt: timeOf(value.proposedFireAt, "proposed_fire_at"),
      target: targetOf(value.target),
      ...(parent ? { parent } : {}),
    };
    assertNoPrivateKey(draft);
    return draft;
  }
  throw new InputError("type", "expected note, thread, or reply");
}

export function fireTimes(draft: Draft): UnixSeconds[] {
  if (draft.type === "thread") return draft.segments.map((segment) => segment.proposedFireAt);
  return [draft.proposedFireAt];
}
