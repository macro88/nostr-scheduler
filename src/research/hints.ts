import { InputError } from "../domain/brand.ts";

export type EngagementTiming = {
  readonly createdAt: number;
  readonly engagement: number;
};

export type HourHint = {
  readonly timezone: string;
  readonly hours: readonly number[];
};

const HINT_HOUR_CAP = 3;

function assertTimezone(timezone: string): void {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new InputError("timezone", "expected an IANA time zone name");
  }
}

function assertTiming(notes: readonly EngagementTiming[]): void {
  for (const note of notes) {
    if (!Number.isInteger(note.createdAt) || note.createdAt < 0) {
      throw new InputError("createdAt", "expected a whole number of seconds");
    }
    if (!Number.isFinite(note.engagement) || note.engagement < 0) {
      throw new InputError("engagement", "expected a non-negative finite number");
    }
  }
}

function hourFrom(format: Intl.DateTimeFormat, createdAt: number): number {
  const raw = Number(format.formatToParts(new Date(createdAt * 1000)).find((part) => part.type === "hour")?.value);
  const hour = raw === 24 ? 0 : raw;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new InputError("timezone", "could not read an hour");
  }
  return hour;
}

export function hintHours(notes: readonly EngagementTiming[], timezone: string): HourHint | null {
  assertTimezone(timezone);
  if (notes.length === 0) return null;
  assertTiming(notes);
  const engagement = notes.reduce((sum, note) => sum + note.engagement, 0);
  if (engagement === 0) return null;
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hourCycle: "h23",
  });
  const buckets = new Array<number>(24).fill(0);
  for (const note of notes) {
    if (note.engagement === 0) continue;
    const hour = hourFrom(format, note.createdAt);
    buckets[hour] = (buckets[hour] ?? 0) + note.engagement;
  }
  const ranked = buckets.flatMap((weight, hour) => (weight > 0 ? [{ hour, weight }] : []));
  const best = ranked.reduce((max, row) => (row.weight > max ? row.weight : max), 0);
  const hours = ranked
    .filter((row) => row.weight === best)
    .map((row) => row.hour)
    .sort((left, right) => left - right);
  if (hours.length === 0 || hours.length > HINT_HOUR_CAP) return null;
  return { timezone, hours };
}

function clockHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function joinHours(hours: readonly number[]): string {
  const labels = hours.map(clockHour);
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  const last = labels[labels.length - 1] ?? "";
  return `${labels.slice(0, -1).join(", ")}, and ${last}`;
}

export function hourHintText(input: {
  readonly notes: readonly EngagementTiming[];
  readonly timezone: string;
  readonly preferredHours: readonly number[] | null;
}): string | null {
  const hint = hintHours(input.notes, input.timezone);
  if (!hint) return null;
  const lead = `Public notes got the most replies, reposts, reactions, and zaps around ${joinHours(hint.hours)} in ${hint.timezone}.`;
  if (input.preferredHours === null) return lead;
  const kept = input.preferredHours.length === 0 ? "unset" : joinHours(input.preferredHours);
  return `${lead} Criteria hours stay ${kept} until you edit them.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hourHintTextFromReport(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.notes)) return null;
  const notes: EngagementTiming[] = [];
  for (const note of value.notes) {
    if (!isRecord(note) || typeof note.createdAt !== "number" || typeof note.engagement !== "number") return null;
    notes.push({ createdAt: note.createdAt, engagement: note.engagement });
  }
  if (value.cadence === undefined || value.cadence === null) {
    try {
      return hourHintText({ notes, timezone: "UTC", preferredHours: null });
    } catch {
      return null;
    }
  }
  if (!isRecord(value.cadence) || typeof value.cadence.timezone !== "string" || !Array.isArray(value.cadence.preferredHours)) {
    return null;
  }
  const preferredHours: number[] = [];
  for (const hour of value.cadence.preferredHours) {
    if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    preferredHours.push(hour);
  }
  try {
    return hourHintText({ notes, timezone: value.cadence.timezone, preferredHours });
  } catch {
    return null;
  }
}
