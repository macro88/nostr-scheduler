import type {
  CriteriaVersion,
  EventId,
  HexPubkey,
  NonEmpty,
  Npub,
  ProfileId,
  RelayUrl,
  Signature,
  SuggesterId,
  SuggestionId,
  UnixSeconds,
} from "./brand.ts";

export type {
  CriteriaVersion,
  EventId,
  HexPubkey,
  NonEmpty,
  Npub,
  ProfileId,
  RelayUrl,
  Signature,
  SuggesterId,
  SuggestionId,
  UnixSeconds,
};

export type V1Kind = 1;
export type Nip10Marker = "root" | "reply" | "mention";
export type EventTag = readonly [string, ...string[]];

export type UnsignedEvent = {
  readonly kind: V1Kind;
  readonly pubkey: HexPubkey;
  readonly created_at: UnixSeconds;
  readonly tags: readonly EventTag[];
  readonly content: string;
};

export type SignedEvent = {
  readonly id: EventId;
  readonly kind: V1Kind;
  readonly pubkey: HexPubkey;
  readonly created_at: UnixSeconds;
  readonly tags: readonly EventTag[];
  readonly content: string;
  readonly sig: Signature;
};

export type Nip07SignerRef = {
  readonly kind: "nip07";
  readonly bindHost: "127.0.0.1";
};

export type Nip46SignerRef = {
  readonly kind: "nip46";
  readonly bunkerUri: string;
};

export type Nip55SignerRef = {
  readonly kind: "nip55";
  readonly platform: "android";
};

export type MockSignerRef = {
  readonly kind: "mock";
};

export type SignerRef = Nip07SignerRef | Nip46SignerRef | Nip55SignerRef | MockSignerRef;

export type RelayPolicy = {
  readonly configured: NonEmpty<RelayUrl>;
  readonly readNip65: boolean;
};

export type Profile = {
  readonly id: ProfileId;
  readonly npub: Npub;
  readonly pubkey: HexPubkey;
  readonly label: string;
  readonly suggesterId: SuggesterId;
  readonly signer: SignerRef;
  readonly relays: RelayPolicy;
  readonly criteriaPath: string;
};

export type PostType = "note" | "thread" | "reply";

export type Cadence = {
  readonly timezone: string;
  readonly postsPerDay: number;
  readonly preferredHours: readonly number[];
};

export type ReplyRules = {
  readonly who: string;
  readonly when: string;
};

export type Criteria = {
  readonly profileId: ProfileId;
  readonly version: CriteriaVersion;
  readonly voice: string;
  readonly topics: readonly string[];
  readonly noGoTopics: readonly string[];
  readonly cadence: Cadence;
  readonly postTypes: NonEmpty<PostType>;
  readonly sources: readonly string[];
  readonly replyRules: ReplyRules;
  readonly goodExamples: readonly string[];
  readonly badExamples: readonly string[];
};

export type FeedbackAction = "approved" | "edited" | "rejected" | "missed";

export type FeedbackEntry = {
  readonly at: UnixSeconds;
  readonly suggestionId: SuggestionId;
  readonly action: FeedbackAction;
  readonly note: string;
  readonly criteriaVersion: CriteriaVersion;
};

export type NoteDraft = {
  readonly type: "note";
  readonly content: string;
  readonly proposedFireAt: UnixSeconds;
};

export type ThreadSegment = {
  readonly content: string;
  readonly proposedFireAt: UnixSeconds;
};

export type ThreadDraft = {
  readonly type: "thread";
  readonly segments: readonly [ThreadSegment, ThreadSegment, ...ThreadSegment[]];
};

export type ReplyTarget = {
  readonly eventId: EventId;
  readonly pubkey: HexPubkey;
  readonly rootId: EventId;
  readonly relayHint?: RelayUrl;
};

export type ReplyDraft = {
  readonly type: "reply";
  readonly content: string;
  readonly proposedFireAt: UnixSeconds;
  readonly target: ReplyTarget;
};

export type Draft = NoteDraft | ThreadDraft | ReplyDraft;

export type Suggestion = {
  readonly status: "suggestion";
  readonly id: SuggestionId;
  readonly profileId: ProfileId;
  readonly suggesterId: SuggesterId;
  readonly draft: Draft;
  readonly createdAt: UnixSeconds;
  readonly rationale: string;
};

export type Approved = {
  readonly status: "approved";
  readonly id: SuggestionId;
  readonly profileId: ProfileId;
  readonly suggesterId: SuggesterId;
  readonly draft: Draft;
  readonly createdAt: UnixSeconds;
  readonly approvedAt: UnixSeconds;
};

export type SignedWork = {
  readonly status: "signed";
  readonly id: SuggestionId;
  readonly profileId: ProfileId;
  readonly events: NonEmpty<SignedEvent>;
  readonly signedAt: UnixSeconds;
};

export type Queued = {
  readonly status: "queued";
  readonly id: SuggestionId;
  readonly profileId: ProfileId;
  readonly events: NonEmpty<SignedEvent>;
  readonly queuedAt: UnixSeconds;
};

export type PerRelayResult = {
  readonly relay: RelayUrl;
  readonly accepted: boolean;
  readonly message: string;
};

export type Sent = {
  readonly status: "sent";
  readonly id: SuggestionId;
  readonly profileId: ProfileId;
  readonly events: NonEmpty<SignedEvent>;
  readonly publishedAt: UnixSeconds;
  readonly results: NonEmpty<PerRelayResult>;
};

export type Failed = {
  readonly status: "failed";
  readonly id: SuggestionId;
  readonly profileId: ProfileId;
  readonly events: NonEmpty<SignedEvent>;
  readonly failedAt: UnixSeconds;
  readonly results: readonly PerRelayResult[];
  readonly reason: string;
};

export type Missed = {
  readonly status: "missed";
  readonly id: SuggestionId;
  readonly profileId: ProfileId;
  readonly events: NonEmpty<SignedEvent>;
  readonly missedAt: UnixSeconds;
  readonly lateBySeconds: number;
};

export type Rejected = {
  readonly status: "rejected";
  readonly id: SuggestionId;
  readonly profileId: ProfileId;
  readonly draft: Draft;
  readonly rejectedAt: UnixSeconds;
  readonly reason: string;
};

export type Discarded = {
  readonly status: "discarded";
  readonly id: SuggestionId;
  readonly profileId: ProfileId;
  readonly discardedAt: UnixSeconds;
  readonly reason: string;
  readonly priorStatus: "approved" | "signed" | "queued" | "failed";
};

export type WorkItem =
  | Suggestion
  | Approved
  | SignedWork
  | Queued
  | Sent
  | Failed
  | Missed
  | Rejected
  | Discarded;

export type Signer = {
  readonly ref: SignerRef;
  readonly pubkey: HexPubkey;
  signEvent(event: UnsignedEvent): Promise<SignedEvent>;
};

export type ThreadSignPlan = {
  readonly pubkey: HexPubkey;
  readonly relayHint: RelayUrl;
  readonly root: UnsignedEvent;
  readonly replyDrafts: NonEmpty<{
    readonly content: string;
    readonly created_at: UnixSeconds;
  }>;
};

export type CatchUpDecision =
  | { readonly action: "wait"; readonly fireAt: UnixSeconds }
  | { readonly action: "publish" }
  | { readonly action: "missed"; readonly lateBySeconds: number };

export type McpToolName =
  | "list_profiles"
  | "get_criteria"
  | "get_thread_context"
  | "suggest_post"
  | "list_queue";

export const MCP_TOOL_NAMES = [
  "list_profiles",
  "get_criteria",
  "get_thread_context",
  "suggest_post",
  "list_queue",
] as const satisfies readonly McpToolName[];

export function signedEventsOf(item: WorkItem): readonly SignedEvent[] | null {
  switch (item.status) {
    case "signed":
    case "queued":
    case "sent":
    case "failed":
    case "missed":
      return item.events;
    default:
      return null;
  }
}
