export type ResearchHit =
  | { readonly kind: "outlier"; readonly id: string; readonly content: string; readonly multiplier: number }
  | { readonly kind: "source"; readonly id: string; readonly content: string }
  | { readonly kind: "brief"; readonly id: string; readonly title: string; readonly summary: string; readonly url?: string };

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) record[key] = field;
  return record;
}

function textField(record: Record<string, unknown>, key: string): string | null {
  const field = record[key];
  if (typeof field !== "string" || field.trim() === "") return null;
  return field;
}

function readHit(value: unknown): ResearchHit | null {
  const record = recordOf(value);
  if (!record) return null;
  const id = textField(record, "id");
  if (id === null || !id.startsWith("res_")) return null;
  const kind = record.kind;
  if (kind === "outlier" || kind === "source") {
    const content = textField(record, "content");
    if (content === null) return null;
    if (kind === "source") return { kind: "source", id, content };
    const multiplier = typeof record.multiplier === "number" && Number.isFinite(record.multiplier) ? record.multiplier : 0;
    return { kind: "outlier", id, content, multiplier };
  }
  if (kind === "brief") {
    const title = textField(record, "title");
    const summary = textField(record, "summary");
    if (title === null || summary === null) return null;
    const url = typeof record.url === "string" && record.url.length > 0 ? record.url : undefined;
    if (url === undefined) return { kind: "brief", id, title, summary };
    return { kind: "brief", id, title, summary, url };
  }
  return null;
}

export function readResearchHits(value: unknown): ResearchHit[] {
  if (!Array.isArray(value)) return [];
  const hits: ResearchHit[] = [];
  for (const item of value) {
    const hit = readHit(item);
    if (hit) hits.push(hit);
  }
  return hits;
}
