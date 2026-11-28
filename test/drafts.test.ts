import { describe, expect, test } from "vitest";
import { draftsOf, type DraftItem } from "../web/src/drafts.ts";

const note = { type: "note", content: "Older note", proposedFireAt: 1_700_000_100 };
const thread = {
  type: "thread",
  segments: [
    { content: "Root line", proposedFireAt: 1_700_000_030 },
    { content: "Reply line", proposedFireAt: 1_700_000_031 },
  ],
};

function item(overrides: Partial<DraftItem> & Pick<DraftItem, "id" | "status">): DraftItem {
  return {
    profileId: "desk",
    preview: "",
    fireAt: [],
    ...overrides,
  };
}

describe("draftsOf", () => {
  test("keeps one profile's drafts and orders them by time then id", () => {
    const older = item({
      id: "sug_b",
      status: "draft",
      preview: "Older note",
      fireAt: [1_700_000_100],
      draft: note,
    });
    const sameTime = item({
      id: "sug_a",
      status: "draft",
      preview: "Same minute",
      fireAt: [1_700_000_100],
      draft: { type: "note", content: "Same minute", proposedFireAt: 1_700_000_100 },
    });
    const threadRow = item({
      id: "sug_thread",
      status: "draft",
      preview: "Root line\nReply line",
      fireAt: [1_700_000_030, 1_700_000_031],
      draft: thread,
    });
    const rows = draftsOf(
      [
        item({ id: "sug_other", profileId: "other", status: "draft", preview: "Elsewhere", fireAt: [1], draft: note }),
        item({ id: "sug_approved", status: "approved", preview: "Older note", fireAt: [1_700_000_100], draft: note }),
        item({ id: "sug_idea", status: "suggestion", preview: "A suggestion", fireAt: [1_700_000_010], draft: note }),
        item({ id: "sug_sent", status: "sent", preview: "Already sent", fireAt: [1_700_000_020] }),
        item({ id: "sug_empty", status: "draft", preview: "Missing body", fireAt: [1_700_000_001] }),
        older,
        sameTime,
        threadRow,
      ],
      "desk",
    );

    expect(rows.map((row) => row.id)).toEqual(["sug_thread", "sug_a", "sug_b"]);
    expect(rows.map((row) => row.preview)).toEqual(["Root line\nReply line", "Same minute", "Older note"]);
    expect(rows.map((row) => row.fireAt)).toEqual([1_700_000_030, 1_700_000_100, 1_700_000_100]);
    expect(rows[2]?.draft).toEqual(note);
    expect(rows[0]?.draft).toEqual(thread);
  });

  test("uses the draft time when the item has no fire time", () => {
    const rows = draftsOf(
      [
        item({
          id: "sug_fallback",
          status: "draft",
          preview: "Held",
          draft: { type: "note", content: "Held", proposedFireAt: 1_700_000_040 },
        }),
      ],
      "desk",
    );
    expect(rows).toEqual([
      {
        id: "sug_fallback",
        preview: "Held",
        fireAt: 1_700_000_040,
        draft: { type: "note", content: "Held", proposedFireAt: 1_700_000_040 },
      },
    ]);
  });
});
