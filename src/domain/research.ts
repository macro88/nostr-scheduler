import { z } from "zod";
import {
  eventId,
  hexPubkey,
  InputError,
  profileId,
  researchId,
  unixSeconds,
  type EventId,
  type HexPubkey,
  type ProfileId,
  type ResearchId,
  type UnixSeconds,
} from "./brand.ts";

export type OutlierSignals = {
  readonly replies: number;
  readonly reposts: number;
  readonly reactions: number;
  readonly zaps: number;
};

export type OutlierHit = {
  readonly kind: "outlier";
  readonly id: ResearchId;
  readonly profileId: ProfileId;
  readonly authorPubkey: HexPubkey;
  readonly eventId: EventId;
  readonly content: string;
  readonly multiplier: number;
  readonly baseline: number;
  readonly signals: OutlierSignals;
  readonly createdAt: UnixSeconds;
  readonly scannedAt: UnixSeconds;
  readonly remixedAt?: UnixSeconds;
};

export type BriefItem = {
  readonly kind: "brief";
  readonly id: ResearchId;
  readonly profileId: ProfileId;
  readonly title: string;
  readonly summary: string;
  readonly url?: string;
  readonly createdAt: UnixSeconds;
  readonly remixedAt?: UnixSeconds;
};

export type SourcePost = {
  readonly kind: "source";
  readonly id: ResearchId;
  readonly profileId: ProfileId;
  readonly authorPubkey: HexPubkey;
  readonly eventId: EventId;
  readonly content: string;
  readonly createdAt: UnixSeconds;
  readonly remixedAt?: UnixSeconds;
};

export type ResearchRecord = OutlierHit | BriefItem | SourcePost;

const text = z.string().refine((value) => value.trim().length > 0);
const seconds = z.number().int().nonnegative();
const count = z.number().int().nonnegative();

const signalsSchema = z.strictObject({
  replies: count,
  reposts: count,
  reactions: count,
  zaps: count,
});

const outlierSchema = z.strictObject({
  kind: z.literal("outlier"),
  id: z.string(),
  profileId: z.string(),
  authorPubkey: z.string(),
  eventId: z.string(),
  content: text,
  multiplier: z.number().finite().nonnegative(),
  baseline: z.number().finite().nonnegative(),
  signals: signalsSchema,
  createdAt: seconds,
  scannedAt: seconds,
  remixedAt: seconds.optional(),
});

const briefSchema = z.strictObject({
  kind: z.literal("brief"),
  id: z.string(),
  profileId: z.string(),
  title: text,
  summary: text,
  url: z.string().min(1).optional(),
  createdAt: seconds,
  remixedAt: seconds.optional(),
});

const sourceSchema = z.strictObject({
  kind: z.literal("source"),
  id: z.string(),
  profileId: z.string(),
  authorPubkey: z.string(),
  eventId: z.string(),
  content: text,
  createdAt: seconds,
  remixedAt: seconds.optional(),
});

const researchSchema = z.discriminatedUnion("kind", [outlierSchema, briefSchema, sourceSchema]);

type ResearchJson = z.infer<typeof researchSchema>;

function pathName(path: readonly PropertyKey[]): string {
  const parts: string[] = [];
  for (const part of path) {
    if (typeof part === "string" || typeof part === "number") parts.push(String(part));
  }
  return parts.length > 0 ? parts.join(".") : "research";
}

function invalid(error: z.ZodError): never {
  const issue = error.issues[0];
  if (issue && "keys" in issue && Array.isArray(issue.keys) && typeof issue.keys[0] === "string") {
    throw new InputError(issue.keys[0], "invalid research record");
  }
  throw new InputError(issue ? pathName(issue.path) : "research", "invalid research record");
}

function httpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InputError("url", "expected an http URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InputError("url", "expected an http URL");
  }
  if (parsed.username || parsed.password) {
    throw new InputError("url", "URLs do not take credentials");
  }
  return value;
}

function outlierOf(value: z.infer<typeof outlierSchema>): OutlierHit {
  const record: OutlierHit = {
    kind: "outlier",
    id: researchId(value.id),
    profileId: profileId(value.profileId),
    authorPubkey: hexPubkey(value.authorPubkey),
    eventId: eventId(value.eventId),
    content: value.content,
    multiplier: value.multiplier,
    baseline: value.baseline,
    signals: value.signals,
    createdAt: unixSeconds(value.createdAt),
    scannedAt: unixSeconds(value.scannedAt),
  };
  if (value.remixedAt === undefined) return record;
  return { ...record, remixedAt: unixSeconds(value.remixedAt) };
}

function briefOf(value: z.infer<typeof briefSchema>): BriefItem {
  const record: BriefItem = {
    kind: "brief",
    id: researchId(value.id),
    profileId: profileId(value.profileId),
    title: value.title,
    summary: value.summary,
    createdAt: unixSeconds(value.createdAt),
  };
  const withUrl = value.url === undefined ? record : { ...record, url: httpUrl(value.url) };
  if (value.remixedAt === undefined) return withUrl;
  return { ...withUrl, remixedAt: unixSeconds(value.remixedAt) };
}

function sourceOf(value: z.infer<typeof sourceSchema>): SourcePost {
  const record: SourcePost = {
    kind: "source",
    id: researchId(value.id),
    profileId: profileId(value.profileId),
    authorPubkey: hexPubkey(value.authorPubkey),
    eventId: eventId(value.eventId),
    content: value.content,
    createdAt: unixSeconds(value.createdAt),
  };
  if (value.remixedAt === undefined) return record;
  return { ...record, remixedAt: unixSeconds(value.remixedAt) };
}

function toRecord(value: ResearchJson): ResearchRecord {
  switch (value.kind) {
    case "outlier":
      return outlierOf(value);
    case "brief":
      return briefOf(value);
    case "source":
      return sourceOf(value);
    default: {
      const _exhaustive: never = value;
      return _exhaustive;
    }
  }
}

export function parseResearchRecord(value: unknown): ResearchRecord {
  const parsed = researchSchema.safeParse(value);
  if (!parsed.success) invalid(parsed.error);
  return toRecord(parsed.data);
}
