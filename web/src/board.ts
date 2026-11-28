export const ROUGH_BODY_LIMIT = 40;

export const BOARD_COLUMNS = [
  { id: "rough", label: "Rough ideas" },
  { id: "writing", label: "Writing" },
  { id: "ready", label: "Ready" },
] as const;

export type BoardColumnId = (typeof BOARD_COLUMNS)[number]["id"];

export type BoardDraft = {
  content?: string;
  segments?: readonly { content?: string }[];
};

export type BoardItem = {
  status: string;
  draft?: BoardDraft;
};

export function isBoardColumn(value: string | null | undefined): value is BoardColumnId {
  return BOARD_COLUMNS.some((column) => column.id === value);
}

export function draftBody(draft: BoardDraft | undefined): string {
  if (!draft) return "";
  if (draft.segments && draft.segments.length > 0) {
    return draft.segments.map((segment) => segment.content ?? "").join("");
  }
  return draft.content ?? "";
}

export function boardColumn(item: BoardItem): BoardColumnId | null {
  if (item.status === "approved") return "ready";
  if (item.status !== "draft") return null;
  return draftBody(item.draft).trim().length < ROUGH_BODY_LIMIT ? "rough" : "writing";
}

export function boardMove(from: BoardColumnId, to: BoardColumnId): "approve" | null {
  if (from === "writing" && to === "ready") return "approve";
  return null;
}
