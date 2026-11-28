export type ResearchTextSource =
  | { readonly kind: "outlier"; readonly content: string }
  | { readonly kind: "source"; readonly content: string }
  | { readonly kind: "brief"; readonly title: string; readonly summary: string; readonly url?: string };

export function researchText(record: ResearchTextSource): string {
  switch (record.kind) {
    case "outlier":
    case "source":
      return record.content;
    case "brief": {
      const parts = [record.title, record.summary];
      if (record.url !== undefined) parts.push(record.url);
      return parts.join("\n\n");
    }
    default: {
      const _exhaustive: never = record;
      return _exhaustive;
    }
  }
}
