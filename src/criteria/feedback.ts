import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import {
  criteriaVersion,
  InputError,
  suggestionId,
  unixSeconds,
  type CriteriaVersion,
  type SuggestionId,
  type UnixSeconds,
} from "../domain/brand.ts";
import type { FeedbackAction, FeedbackEntry } from "../domain/types.ts";

const ACTIONS = new Set<FeedbackAction>(["approved", "edited", "rejected", "missed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function feedbackPath(criteriaPath: string, profile: string): string {
  return join(dirname(criteriaPath), `${profile}.feedback.yaml`);
}

function parseEntry(value: unknown): FeedbackEntry {
  if (!isRecord(value)) throw new InputError("entries", "expected a mapping");
  if (typeof value.at !== "number") throw new InputError("at", "expected a number");
  if (typeof value.suggestion_id !== "string") throw new InputError("suggestion_id", "expected a string");
  if (typeof value.action !== "string" || !ACTIONS.has(value.action as FeedbackAction)) {
    throw new InputError("action", "expected approved, edited, rejected, or missed");
  }
  if (typeof value.note !== "string") throw new InputError("note", "expected a string");
  if (typeof value.criteria_version !== "string") throw new InputError("criteria_version", "expected a string");
  return {
    at: unixSeconds(value.at),
    suggestionId: suggestionId(value.suggestion_id),
    action: value.action as FeedbackAction,
    note: value.note,
    criteriaVersion: criteriaVersion(value.criteria_version),
  };
}

export function readFeedback(path: string): FeedbackEntry[] {
  try {
    const raw = parse(readFileSync(path, "utf8"));
    if (!isRecord(raw) || !Array.isArray(raw.entries)) return [];
    return raw.entries.map(parseEntry);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function toYaml(entry: FeedbackEntry): Record<string, unknown> {
  return {
    at: entry.at,
    suggestion_id: entry.suggestionId,
    action: entry.action,
    note: entry.note,
    criteria_version: entry.criteriaVersion,
  };
}

export function appendFeedback(path: string, entry: FeedbackEntry): FeedbackEntry[] {
  const existing = readFeedback(path);
  const next = [...existing, entry];
  mkdirSync(dirname(path), { recursive: true });
  const body = stringify({ entries: next.map(toYaml) });
  writeFileSync(path, body, { mode: 0o644 });
  const written = readFeedback(path);
  for (let i = 0; i < existing.length; i += 1) {
    if (JSON.stringify(written[i]) !== JSON.stringify(existing[i])) {
      throw new Error("feedback log rewrote an existing entry");
    }
  }
  return written;
}

export function feedbackEntry(args: {
  at: UnixSeconds;
  suggestionId: SuggestionId;
  action: FeedbackAction;
  note: string;
  criteriaVersion: CriteriaVersion;
}): FeedbackEntry {
  return args;
}
