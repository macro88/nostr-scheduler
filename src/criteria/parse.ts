import { parse as parseYaml } from "yaml";
import {
  criteriaVersion,
  InputError,
  nonEmpty,
  profileId,
  type CriteriaVersion,
  type ProfileId,
} from "../domain/brand.ts";
import type { Criteria, PostType, ReplyRules } from "../domain/types.ts";

const HEADINGS = ["Voice", "Reply rules", "Good examples", "Bad examples"] as const;
const POST_TYPES = new Set<PostType>(["note", "thread", "reply"]);
const FRONT_KEYS = new Set([
  "profile_id",
  "version",
  "timezone",
  "posts_per_day",
  "preferred_hours",
  "post_types",
  "topics",
  "no_go_topics",
  "sources",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new InputError(field, "expected a list of strings");
  }
  return value;
}

function assertTimezone(value: string): void {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new InputError("timezone", "expected an IANA time zone name");
  }
}

function sectionItems(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
}

function splitFrontMatter(text: string): { front: string; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) throw new InputError("front_matter", "expected YAML front matter");
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) throw new InputError("front_matter", "front matter was not closed");
  return { front: normalized.slice(4, end), body: normalized.slice(end + 5) };
}

function sectionsOf(body: string): Record<string, string> {
  const matches = [...body.matchAll(/^# (.+)$/gm)];
  if (matches.length === 0) throw new InputError("body", "expected the required headings");
  const found = new Map<string, string>();
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const title = match?.[1]?.trim();
    if (!title || match?.index === undefined) throw new InputError("body", "empty heading");
    if (!(HEADINGS as readonly string[]).includes(title)) {
      throw new InputError("body", `unknown heading ${title}`);
    }
    if (found.has(title)) throw new InputError("body", `duplicate heading ${title}`);
    const start = match.index + match[0].length;
    const next = matches[i + 1]?.index ?? body.length;
    found.set(title, body.slice(start, next).trim());
  }
  for (const heading of HEADINGS) {
    if (!found.has(heading)) throw new InputError(heading, "heading is required");
  }
  return Object.fromEntries(found);
}

function replyRules(text: string): ReplyRules {
  const parts = text.split(/\n\s*\n/).map((part) => part.trim()).filter((part) => part.length > 0);
  return { who: parts[0] ?? text, when: parts.slice(1).join("\n\n") || text };
}

export function parseCriteria(text: string, expectedProfile?: ProfileId): Criteria {
  const { front, body } = splitFrontMatter(text);
  const raw = parseYaml(front);
  if (!isRecord(raw)) throw new InputError("front_matter", "expected a mapping");
  for (const key of Object.keys(raw)) {
    if (!FRONT_KEYS.has(key)) throw new InputError(key, "unknown front-matter field");
  }
  if (typeof raw.profile_id !== "string") throw new InputError("profile_id", "expected a string");
  const profile = profileId(raw.profile_id);
  if (expectedProfile && profile !== expectedProfile) {
    throw new InputError("profile_id", "does not match the profile");
  }
  if (typeof raw.version !== "string") throw new InputError("version", "expected a string");
  const version: CriteriaVersion = criteriaVersion(raw.version);
  if (typeof raw.timezone !== "string") throw new InputError("timezone", "expected a string");
  assertTimezone(raw.timezone);
  if (typeof raw.posts_per_day !== "number" || !Number.isFinite(raw.posts_per_day) || raw.posts_per_day < 0) {
    throw new InputError("posts_per_day", "expected a non-negative number");
  }
  if (!Array.isArray(raw.preferred_hours)) throw new InputError("preferred_hours", "expected a list");
  const preferredHours = raw.preferred_hours.map((hour) => {
    if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new InputError("preferred_hours", "each hour must be an integer from 0 to 23");
    }
    return hour;
  });
  const postTypeValues = stringList(raw.post_types, "post_types");
  if (postTypeValues.length === 0) throw new InputError("post_types", "expected a non-empty list");
  const postTypes = postTypeValues.map((value) => {
    if (!POST_TYPES.has(value as PostType)) throw new InputError("post_types", `unknown post type ${value}`);
    return value as PostType;
  });
  const sections = sectionsOf(body);
  return {
    profileId: profile,
    version,
    voice: sections.Voice ?? "",
    topics: stringList(raw.topics, "topics"),
    noGoTopics: stringList(raw.no_go_topics, "no_go_topics"),
    cadence: { timezone: raw.timezone, postsPerDay: raw.posts_per_day, preferredHours },
    postTypes: nonEmpty(postTypes, "post_types"),
    sources: stringList(raw.sources, "sources"),
    replyRules: replyRules(sections["Reply rules"] ?? ""),
    goodExamples: sectionItems(sections["Good examples"] ?? ""),
    badExamples: sectionItems(sections["Bad examples"] ?? ""),
  };
}
