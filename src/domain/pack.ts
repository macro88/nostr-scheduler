export type PackInput = {
  readonly id: string;
  readonly createdAt: number;
  readonly rationale: string;
};

export type PackGroup<T extends PackInput> = {
  readonly by: "tag" | "day";
  readonly key: string;
  readonly label: string;
  readonly items: readonly T[];
};

export type GroupSuggestionsOptions = {
  readonly timeZone?: string;
  readonly now?: number;
};

export type BriefView = {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly url?: string;
};

const tagPattern = /#([A-Za-z0-9][A-Za-z0-9-]*)/;

function rationaleTag(rationale: string): string | undefined {
  const match = tagPattern.exec(rationale);
  return match?.[1]?.toLowerCase();
}

function calendarDay(seconds: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(seconds * 1000));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return "1970-01-01";
  return `${year}-${month}-${day}`;
}

function tagLabel(tag: string): string {
  if (tag === "morning") return "Morning pack";
  const head = tag.charAt(0).toUpperCase();
  return `${head}${tag.slice(1)}`;
}

function dayLabel(day: string, today: string, morningTagged: boolean): string {
  if (day === today) return morningTagged ? "Today" : "Morning pack";
  const [year, month, date] = day.split("-");
  const y = Number(year);
  const m = Number(month);
  const d = Number(date);
  if (!y || !m || !d) return day;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function pushItem<T>(buckets: Map<string, T[]>, order: string[], key: string, item: T): void {
  const list = buckets.get(key);
  if (list) {
    list.push(item);
    return;
  }
  buckets.set(key, [item]);
  order.push(key);
}

export function groupSuggestions<T extends PackInput>(
  items: readonly T[],
  options: GroupSuggestionsOptions = {},
): readonly PackGroup<T>[] {
  const timeZone = options.timeZone && options.timeZone.length > 0 ? options.timeZone : "UTC";
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const today = calendarDay(now, timeZone);
  const tags = new Map<string, T[]>();
  const days = new Map<string, T[]>();
  const tagOrder: string[] = [];
  const dayOrder: string[] = [];
  for (const item of items) {
    const tag = rationaleTag(item.rationale);
    if (tag) pushItem(tags, tagOrder, tag, item);
    else pushItem(days, dayOrder, calendarDay(item.createdAt, timeZone), item);
  }
  const morningTagged = tagOrder.includes("morning");
  const orderedTags = morningTagged ? ["morning", ...tagOrder.filter((tag) => tag !== "morning")] : tagOrder;
  const orderedDays = [...dayOrder].sort((left, right) => right.localeCompare(left));
  return [
    ...orderedTags.map((key) => ({
      by: "tag" as const,
      key,
      label: tagLabel(key),
      items: tags.get(key) ?? [],
    })),
    ...orderedDays.map((key) => ({
      by: "day" as const,
      key,
      label: dayLabel(key, today, morningTagged),
      items: days.get(key) ?? [],
    })),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpUrl(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  return value;
}

export function selectBriefs(value: unknown): readonly BriefView[] {
  if (!Array.isArray(value)) return [];
  const briefs: BriefView[] = [];
  for (const row of value) {
    if (!isRecord(row) || row.kind !== "brief") continue;
    if (typeof row.id !== "string" || typeof row.title !== "string" || typeof row.summary !== "string") continue;
    const url = typeof row.url === "string" ? httpUrl(row.url) : undefined;
    const brief: BriefView = { id: row.id, title: row.title, summary: row.summary };
    briefs.push(url === undefined ? brief : { ...brief, url });
  }
  return briefs;
}
