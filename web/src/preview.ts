export type PreviewSource =
  | { kind: "note"; note: string }
  | { kind: "thread"; parts: readonly string[] }
  | { kind: "reply"; reply: string };

export type PreviewProjection = {
  title?: string;
  lines: string[];
};

export function previewParts(source: PreviewSource): PreviewProjection {
  switch (source.kind) {
    case "note":
      return { lines: source.note === "" ? [] : [source.note] };
    case "thread":
      return { lines: source.parts.every((part) => part === "") ? [] : [...source.parts] };
    case "reply":
      return { lines: source.reply === "" ? [] : [source.reply] };
    default: {
      const unreachable: never = source;
      return unreachable;
    }
  }
}
