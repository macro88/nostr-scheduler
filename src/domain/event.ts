import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  eventId,
  hexPubkey,
  InputError,
  nonEmpty,
  signature,
  unixSeconds,
  type EventId,
  type HexPubkey,
  type RelayUrl,
  type UnixSeconds,
} from "./brand.ts";
import type {
  EventTag,
  ReplyDraft,
  SignedEvent,
  ThreadDraft,
  ThreadSignPlan,
  UnsignedEvent,
} from "./types.ts";

export type RawEvent = {
  readonly id: EventId;
  readonly pubkey: HexPubkey;
  readonly created_at: UnixSeconds;
  readonly kind: number;
  readonly tags: readonly EventTag[];
  readonly content: string;
  readonly sig: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTags(value: unknown): EventTag[] {
  if (!Array.isArray(value)) throw new InputError("tags", "expected an array");
  return value.map((tag, index) => {
    if (!Array.isArray(tag) || tag.length === 0 || tag.some((part) => typeof part !== "string")) {
      throw new InputError("tags", `tag ${index} must be a non-empty array of strings`);
    }
    const [first, ...rest] = tag;
    if (first === undefined) throw new InputError("tags", `tag ${index} is empty`);
    return [first, ...rest];
  });
}

export function canonicalId(parts: {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: readonly EventTag[];
  content: string;
}): EventId {
  const payload = JSON.stringify([0, parts.pubkey, parts.created_at, parts.kind, parts.tags, parts.content]);
  return eventId(bytesToHex(sha256(new TextEncoder().encode(payload))));
}

export function verifyRawSignature(event: RawEvent): boolean {
  const id = canonicalId(event);
  if (id !== event.id) return false;
  try {
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

export function parseRawEvent(value: unknown): RawEvent {
  if (!isRecord(value)) throw new InputError("event", "expected an object");
  const kind = value.kind;
  if (typeof kind !== "number" || !Number.isInteger(kind)) throw new InputError("kind", "expected an integer");
  const created = value.created_at;
  if (typeof created !== "number") throw new InputError("created_at", "expected a number");
  const content = value.content;
  if (typeof content !== "string") throw new InputError("content", "expected a string");
  const sig = value.sig;
  if (typeof sig !== "string") throw new InputError("sig", "expected a string");
  const pubkey = value.pubkey;
  if (typeof pubkey !== "string") throw new InputError("pubkey", "expected a string");
  const id = value.id;
  if (typeof id !== "string") throw new InputError("id", "expected a string");
  const event: RawEvent = {
    id: eventId(id),
    pubkey: hexPubkey(pubkey),
    created_at: unixSeconds(created),
    kind,
    tags: parseTags(value.tags),
    content,
    sig: signature(sig),
  };
  if (!verifyRawSignature(event)) throw new InputError("sig", "id or signature does not verify");
  return event;
}

export function parseSignedEvent(value: unknown): SignedEvent {
  const raw = parseRawEvent(value);
  if (raw.kind !== 1) throw new InputError("kind", "only kind 1 is accepted");
  return {
    id: raw.id,
    pubkey: raw.pubkey,
    created_at: raw.created_at,
    kind: 1,
    tags: raw.tags,
    content: raw.content,
    sig: signature(raw.sig),
  };
}

export function assertSamePayload(expected: UnsignedEvent, actual: SignedEvent): void {
  if (actual.pubkey !== expected.pubkey) throw new Error("signed event pubkey does not match");
  if (actual.created_at !== expected.created_at) throw new Error("signed event created_at does not match");
  if (actual.kind !== expected.kind) throw new Error("signed event kind does not match");
  if (actual.content !== expected.content) throw new Error("signed event content does not match");
  if (JSON.stringify(actual.tags) !== JSON.stringify(expected.tags)) {
    throw new Error("signed event tags do not match");
  }
}

export function noteUnsigned(args: {
  pubkey: HexPubkey;
  content: string;
  createdAt: UnixSeconds;
}): UnsignedEvent {
  return {
    kind: 1,
    pubkey: args.pubkey,
    created_at: args.createdAt,
    tags: [],
    content: args.content,
  };
}

export function replyUnsigned(args: {
  pubkey: HexPubkey;
  draft: ReplyDraft;
  relayHint: RelayUrl;
}): UnsignedEvent {
  const hint = args.draft.target.relayHint ?? args.relayHint;
  return {
    kind: 1,
    pubkey: args.pubkey,
    created_at: args.draft.proposedFireAt,
    content: args.draft.content,
    tags: [
      ["e", args.draft.target.rootId, hint, "root"],
      ["e", args.draft.target.eventId, hint, "reply"],
      ["p", args.draft.target.pubkey, hint],
    ],
  };
}

export function assertIncreasingTimes(times: readonly UnixSeconds[]): void {
  for (let i = 1; i < times.length; i += 1) {
    const prev = times[i - 1];
    const next = times[i];
    if (prev === undefined || next === undefined || next <= prev) {
      throw new InputError("proposed_fire_at", "thread fire times must increase");
    }
  }
}

export function threadPlanFromDraft(args: {
  pubkey: HexPubkey;
  draft: ThreadDraft;
  relayHint: RelayUrl;
}): ThreadSignPlan {
  assertIncreasingTimes(args.draft.segments.map((segment) => segment.proposedFireAt));
  const [root, ...replies] = args.draft.segments;
  if (root === undefined) throw new InputError("segments", "a thread needs a root and a reply");
  return {
    pubkey: args.pubkey,
    relayHint: args.relayHint,
    root: {
      kind: 1,
      pubkey: args.pubkey,
      created_at: root.proposedFireAt,
      tags: [],
      content: root.content,
    },
    replyDrafts: nonEmpty(
      replies.map((segment) => ({ content: segment.content, created_at: segment.proposedFireAt })),
      "segments",
    ),
  };
}

export function nextThreadUnsigned(args: {
  plan: ThreadSignPlan;
  signedSoFar: readonly [SignedEvent, ...SignedEvent[]];
}): UnsignedEvent {
  const root = args.signedSoFar[0];
  const reply = args.plan.replyDrafts[args.signedSoFar.length - 1];
  const parent = args.signedSoFar[args.signedSoFar.length - 1];
  if (reply === undefined || parent === undefined) {
    throw new Error("thread plan has no further reply");
  }
  if (reply.created_at <= parent.created_at) {
    throw new InputError("proposed_fire_at", "thread fire times must increase");
  }
  const hint = args.plan.relayHint;
  return {
    kind: 1,
    pubkey: args.plan.pubkey,
    created_at: reply.created_at,
    content: reply.content,
    tags: [
      ["e", root.id, hint, "root"],
      ["e", parent.id, hint, "reply"],
      ["p", root.pubkey, hint],
    ],
  };
}

export function eventsMatch(left: readonly SignedEvent[], right: readonly SignedEvent[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
