import { nonEmpty, type UnixSeconds } from "./brand.ts";
import type {
  Approved,
  Discarded,
  Draft,
  Failed,
  Missed,
  NonEmpty,
  PerRelayResult,
  Queued,
  Rejected,
  SignedEvent,
  SignedWork,
  Suggestion,
  WorkItem,
} from "./types.ts";

export function approve(item: Suggestion, at: UnixSeconds): Approved {
  return {
    status: "approved",
    id: item.id,
    profileId: item.profileId,
    suggesterId: item.suggesterId,
    draft: item.draft,
    createdAt: item.createdAt,
    approvedAt: at,
  };
}

export function reject(item: Suggestion, args: { at: UnixSeconds; reason: string }): Rejected {
  return {
    status: "rejected",
    id: item.id,
    profileId: item.profileId,
    draft: item.draft,
    rejectedAt: args.at,
    reason: args.reason,
  };
}

export function editSuggestion(item: Suggestion, draft: Draft): Suggestion {
  return { ...item, draft };
}

export function editApproved(item: Approved, draft: Draft): Approved {
  return { ...item, draft };
}

export function markSigned(
  item: Approved,
  args: { events: NonEmpty<SignedEvent>; at: UnixSeconds },
): SignedWork {
  return {
    status: "signed",
    id: item.id,
    profileId: item.profileId,
    events: args.events,
    signedAt: args.at,
  };
}

export function enqueue(item: SignedWork, at: UnixSeconds): Queued {
  return {
    status: "queued",
    id: item.id,
    profileId: item.profileId,
    events: item.events,
    queuedAt: at,
  };
}

export function markSent(
  item: Queued,
  args: { at: UnixSeconds; results: NonEmpty<PerRelayResult> },
): import("./types.ts").Sent {
  if (!args.results.some((result) => result.accepted)) {
    throw new Error("sent requires at least one relay acceptance");
  }
  return {
    status: "sent",
    id: item.id,
    profileId: item.profileId,
    events: item.events,
    publishedAt: args.at,
    results: args.results,
  };
}

export function markFailed(
  item: Queued,
  args: { at: UnixSeconds; results: readonly PerRelayResult[]; reason: string },
): Failed {
  if (args.results.some((result) => result.accepted)) {
    throw new Error("failed cannot include an acceptance");
  }
  return {
    status: "failed",
    id: item.id,
    profileId: item.profileId,
    events: item.events,
    failedAt: args.at,
    results: args.results,
    reason: args.reason,
  };
}

export function markMissed(item: Queued, args: { at: UnixSeconds; lateBySeconds: number }): Missed {
  if (!Number.isInteger(args.lateBySeconds) || args.lateBySeconds < 0) {
    throw new Error("lateBySeconds must be a non-negative integer");
  }
  return {
    status: "missed",
    id: item.id,
    profileId: item.profileId,
    events: item.events,
    missedAt: args.at,
    lateBySeconds: args.lateBySeconds,
  };
}

export function discard(
  item: Approved | SignedWork | Queued | Failed,
  args: { at: UnixSeconds; reason: string },
): Discarded {
  return {
    status: "discarded",
    id: item.id,
    profileId: item.profileId,
    discardedAt: args.at,
    reason: args.reason,
    priorStatus: item.status,
  };
}

export type WorkCommand =
  | { readonly type: "approve" }
  | { readonly type: "reject"; readonly reason: string }
  | { readonly type: "edit"; readonly draft: Draft }
  | { readonly type: "sign"; readonly events: readonly SignedEvent[] }
  | { readonly type: "enqueue" }
  | { readonly type: "sent"; readonly results: readonly PerRelayResult[] }
  | { readonly type: "failed"; readonly results: readonly PerRelayResult[]; readonly reason: string }
  | { readonly type: "missed"; readonly lateBySeconds: number }
  | { readonly type: "discard"; readonly reason: string };

export function applyCommand(item: WorkItem, command: WorkCommand, at: UnixSeconds): WorkItem {
  switch (item.status) {
    case "suggestion":
      if (command.type === "approve") return approve(item, at);
      if (command.type === "reject") return reject(item, { at, reason: command.reason });
      if (command.type === "edit") return editSuggestion(item, command.draft);
      break;
    case "approved":
      if (command.type === "edit") return editApproved(item, command.draft);
      if (command.type === "sign") return markSigned(item, { events: nonEmpty(command.events, "events"), at });
      if (command.type === "discard") return discard(item, { at, reason: command.reason });
      break;
    case "signed":
      if (command.type === "enqueue") return enqueue(item, at);
      if (command.type === "discard") return discard(item, { at, reason: command.reason });
      break;
    case "queued":
      if (command.type === "sent") {
        return markSent(item, { at, results: nonEmpty(command.results, "results") });
      }
      if (command.type === "failed") {
        return markFailed(item, { at, results: command.results, reason: command.reason });
      }
      if (command.type === "missed") return markMissed(item, { at, lateBySeconds: command.lateBySeconds });
      if (command.type === "discard") return discard(item, { at, reason: command.reason });
      break;
    case "failed":
      if (command.type === "discard") return discard(item, { at, reason: command.reason });
      break;
    default:
      break;
  }
  throw new Error(`cannot ${command.type} a ${item.status} item`);
}
