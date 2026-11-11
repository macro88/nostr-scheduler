import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { appendFeedback, feedbackEntry, feedbackPath } from "../criteria/feedback.ts";
import { parseCriteria } from "../criteria/parse.ts";
import { readFileSync } from "node:fs";
import {
  profileId,
  relayUrl,
  suggestionId,
  suggesterId,
  unixSeconds,
  type ProfileId,
  type SuggestionId,
  type UnixSeconds,
} from "../domain/brand.ts";
import { parseDraft } from "../domain/draft.ts";
import { eventsMatch, parseSignedEvent } from "../domain/event.ts";
import { applyCommand, type WorkCommand } from "../domain/transitions.ts";
import type {
  Draft,
  FeedbackAction,
  PerRelayResult,
  Profile,
  SignedEvent,
  Suggestion,
  SuggesterId,
  WorkItem,
} from "../domain/types.ts";
import { signedEventsOf } from "../domain/types.ts";

type Row = { id: string; body_json: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWorkItem(value: unknown): WorkItem {
  if (!isRecord(value) || typeof value.status !== "string") throw new Error("stored item is not a work item");
  const id = suggestionId(String(value.id));
  const profile = profileId(String(value.profileId));
  const base = { id, profileId: profile };
  if (value.status === "suggestion" || value.status === "approved") {
    const draft = parseDraft(value.draft);
    const suggester = suggesterId(String(value.suggesterId));
    const createdAt = unixSeconds(Number(value.createdAt));
    if (value.status === "suggestion") {
      return { ...base, status: "suggestion", suggesterId: suggester, draft, createdAt, rationale: String(value.rationale ?? "") };
    }
    return {
      ...base,
      status: "approved",
      suggesterId: suggester,
      draft,
      createdAt,
      approvedAt: unixSeconds(Number(value.approvedAt)),
    };
  }
  if (value.status === "rejected") {
    return {
      ...base,
      status: "rejected",
      draft: parseDraft(value.draft),
      rejectedAt: unixSeconds(Number(value.rejectedAt)),
      reason: String(value.reason ?? ""),
    };
  }
  if (value.status === "discarded") {
    const prior = value.priorStatus;
    if (prior !== "approved" && prior !== "signed" && prior !== "queued" && prior !== "failed") {
      throw new Error("discarded item has no prior status");
    }
    return {
      ...base,
      status: "discarded",
      discardedAt: unixSeconds(Number(value.discardedAt)),
      reason: String(value.reason ?? ""),
      priorStatus: prior,
    };
  }
  if (!Array.isArray(value.events)) throw new Error("stored item is missing events");
  const events = value.events.map(parseSignedEvent);
  const [first, ...rest] = events;
  if (first === undefined) throw new Error("stored item is missing events");
  const signedEvents = [first, ...rest] as const;
  if (value.status === "signed") {
    return { ...base, status: "signed", events: signedEvents, signedAt: unixSeconds(Number(value.signedAt)) };
  }
  if (value.status === "queued") {
    return { ...base, status: "queued", events: signedEvents, queuedAt: unixSeconds(Number(value.queuedAt)) };
  }
  if (value.status === "sent") {
    if (!Array.isArray(value.results) || value.results.length === 0) throw new Error("sent item is missing results");
    const results = value.results.map(parseResult);
    const [result, ...more] = results;
    if (result === undefined) throw new Error("sent item is missing results");
    return {
      ...base,
      status: "sent",
      events: signedEvents,
      publishedAt: unixSeconds(Number(value.publishedAt)),
      results: [result, ...more],
    };
  }
  if (value.status === "failed") {
    return {
      ...base,
      status: "failed",
      events: signedEvents,
      failedAt: unixSeconds(Number(value.failedAt)),
      results: Array.isArray(value.results) ? value.results.map(parseResult) : [],
      reason: String(value.reason ?? ""),
    };
  }
  if (value.status === "missed") {
    return {
      ...base,
      status: "missed",
      events: signedEvents,
      missedAt: unixSeconds(Number(value.missedAt)),
      lateBySeconds: Number(value.lateBySeconds),
    };
  }
  throw new Error(`unknown status ${value.status}`);
}

function feedbackActionFor(command: WorkCommand): FeedbackAction | null {
  if (command.type === "approve") return "approved";
  if (command.type === "edit") return "edited";
  if (command.type === "reject") return "rejected";
  if (command.type === "missed") return "missed";
  return null;
}

function parseResult(value: unknown): PerRelayResult {
  if (!isRecord(value) || typeof value.relay !== "string") throw new Error("bad relay result");
  return {
    relay: relayUrl(String(value.relay)),
    accepted: value.accepted === true,
    message: String(value.message ?? ""),
  };
}

export class WorkStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        status TEXT NOT NULL,
        body_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publish_log (
        suggestion_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        relay TEXT NOT NULL,
        accepted INTEGER NOT NULL,
        message TEXT NOT NULL,
        at_seconds INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seen_events (
        id TEXT PRIMARY KEY,
        body_json TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  suggest(args: {
    profile: Profile;
    suggesterId: SuggesterId;
    draft: Draft;
    rationale: string;
    at: UnixSeconds;
    id?: SuggestionId;
  }): Suggestion {
    if (args.suggesterId !== args.profile.suggesterId) {
      throw new Error("this profile has a different suggester");
    }
    const item: Suggestion = {
      status: "suggestion",
      id: args.id ?? suggestionId(`sug_${randomBytes(8).toString("hex")}`),
      profileId: args.profile.id,
      suggesterId: args.suggesterId,
      draft: args.draft,
      createdAt: args.at,
      rationale: args.rationale,
    };
    this.insert(item);
    return item;
  }

  get(id: SuggestionId): WorkItem {
    const row = this.db.prepare("SELECT body_json FROM work_items WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`no item ${id}`);
    return parseWorkItem(JSON.parse(row.body_json));
  }

  list(profileId?: ProfileId): WorkItem[] {
    const rows = profileId
      ? (this.db.prepare("SELECT body_json FROM work_items WHERE profile_id = ? ORDER BY id").all(profileId) as Row[])
      : (this.db.prepare("SELECT body_json FROM work_items ORDER BY id").all() as Row[]);
    return rows.map((row) => parseWorkItem(JSON.parse(row.body_json)));
  }

  transition(id: SuggestionId, command: WorkCommand, at: UnixSeconds, profile?: Profile): WorkItem {
    const current = this.get(id);
    const next = applyCommand(current, command, at);
    const before = signedEventsOf(current);
    const after = signedEventsOf(next);
    if (before && after && !eventsMatch(before, after)) {
      throw new Error("signed events are frozen");
    }
    this.save(next);
    const feedbackAction = feedbackActionFor(command);
    if (profile && feedbackAction) this.logFeedback(profile, id, feedbackAction, at, command);
    return next;
  }

  recordPublish(args: {
    suggestionId: SuggestionId;
    eventId: string;
    relay: string;
    accepted: boolean;
    message: string;
    at: UnixSeconds;
  }): void {
    this.db
      .prepare(
        "INSERT INTO publish_log (suggestion_id, event_id, relay, accepted, message, at_seconds) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(args.suggestionId, args.eventId, args.relay, args.accepted ? 1 : 0, args.message, args.at);
  }

  hasAccept(suggestionId: SuggestionId, eventId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS hit FROM publish_log WHERE suggestion_id = ? AND event_id = ? AND accepted = 1 LIMIT 1")
      .get(suggestionId, eventId) as { hit: number } | undefined;
    return row !== undefined;
  }

  resultsFor(suggestionId: SuggestionId): PerRelayResult[] {
    const rows = this.db
      .prepare("SELECT relay, accepted, message FROM publish_log WHERE suggestion_id = ? ORDER BY at_seconds, rowid")
      .all(suggestionId) as { relay: string; accepted: number; message: string }[];
    return rows.map((row) => ({
      relay: relayUrl(row.relay),
      accepted: row.accepted === 1,
      message: row.message,
    }));
  }

  remember(event: SignedEvent): void {
    this.db
      .prepare("INSERT INTO seen_events (id, body_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body_json = excluded.body_json")
      .run(event.id, JSON.stringify(event));
  }

  recall(id: string): SignedEvent | null {
    const row = this.db.prepare("SELECT body_json FROM seen_events WHERE id = ?").get(id) as { body_json: string } | undefined;
    if (!row) return null;
    return parseSignedEvent(JSON.parse(row.body_json));
  }

  private logFeedback(profile: Profile, id: SuggestionId, action: FeedbackAction, at: UnixSeconds, command: WorkCommand): void {
    const criteria = parseCriteria(readFileSync(profile.criteriaPath, "utf8"), profile.id);
    const note =
      command.type === "reject" || command.type === "discard"
        ? command.reason
        : command.type === "missed"
          ? "missed the catch-up window"
          : "";
    appendFeedback(
      feedbackPath(profile.criteriaPath, profile.id),
      feedbackEntry({
        at,
        suggestionId: id,
        action,
        note,
        criteriaVersion: criteria.version,
      }),
    );
  }

  private insert(item: WorkItem): void {
    this.db
      .prepare("INSERT INTO work_items (id, profile_id, status, body_json) VALUES (?, ?, ?, ?)")
      .run(item.id, item.profileId, item.status, JSON.stringify(item));
  }

  private save(item: WorkItem): void {
    this.db
      .prepare("UPDATE work_items SET status = ?, body_json = ? WHERE id = ?")
      .run(item.status, JSON.stringify(item), item.id);
  }
}
