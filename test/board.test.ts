import { describe, expect, test } from "vitest";
import { boardColumn, boardMove, draftBody, ROUGH_BODY_LIMIT, type BoardColumnId, type BoardItem } from "../web/src/board.ts";

const statuses = ["draft", "suggestion", "approved", "rejected", "signed", "queued", "sent", "failed", "missed", "discarded"] as const;

function item(status: string, content = "A note with enough body to count as writing."): BoardItem {
  return { status, draft: { content } };
}

describe("boardColumn", () => {
  test("assigns each status once", () => {
    const columns = {
      draft: boardColumn(item("draft", "Sketch")),
      suggestion: boardColumn(item("suggestion")),
      approved: boardColumn(item("approved", "")),
      rejected: boardColumn(item("rejected")),
      signed: boardColumn({ status: "signed" }),
      queued: boardColumn({ status: "queued" }),
      sent: boardColumn({ status: "sent" }),
      failed: boardColumn({ status: "failed" }),
      missed: boardColumn({ status: "missed" }),
      discarded: boardColumn({ status: "discarded" }),
    } satisfies Record<(typeof statuses)[number], BoardColumnId | null>;

    expect(Object.keys(columns).sort()).toEqual([...statuses].sort());
    expect(columns).toEqual({
      draft: "rough",
      suggestion: null,
      approved: "ready",
      rejected: null,
      signed: null,
      queued: null,
      sent: null,
      failed: null,
      missed: null,
      discarded: null,
    });
  });

  test("puts a draft under 40 trimmed characters in Rough ideas and the rest in Writing", () => {
    expect(ROUGH_BODY_LIMIT).toBe(40);
    expect(boardColumn(item("draft", ""))).toBe("rough");
    expect(boardColumn(item("draft", "   \n  "))).toBe("rough");
    expect(boardColumn({ status: "draft" })).toBe("rough");
    expect(boardColumn(item("draft", "x".repeat(39)))).toBe("rough");
    expect(boardColumn(item("draft", `  ${"x".repeat(39)}  `))).toBe("rough");
    expect(boardColumn(item("draft", "x".repeat(40)))).toBe("writing");
    expect(boardColumn(item("draft", "A writing note that is long enough to leave rough."))).toBe("writing");
  });

  test("measures thread text as the segment characters and ignores a missing body", () => {
    expect(draftBody(undefined)).toBe("");
    expect(draftBody({ segments: [{ content: "x".repeat(20) }, { content: "y".repeat(19) }] })).toBe(`${"x".repeat(20)}${"y".repeat(19)}`);
    expect(boardColumn({ status: "draft", draft: { segments: [{ content: "x".repeat(20) }, { content: "y".repeat(19) }] } })).toBe("rough");
    expect(boardColumn({ status: "draft", draft: { segments: [{ content: "x".repeat(20) }, { content: "y".repeat(20) }] } })).toBe("writing");
    expect(boardColumn({ status: "draft", draft: { segments: [{ content: undefined }, { content: "Sketch" }] } })).toBe("rough");
    expect(boardColumn({ status: "approved", draft: { content: "x" } })).toBe("ready");
  });
});

describe("boardMove", () => {
  test("approves only when a writing note moves to Ready", () => {
    const columns = ["rough", "writing", "ready"] as const satisfies readonly BoardColumnId[];
    const moves = columns.flatMap((from) => columns.map((to) => [from, to, boardMove(from, to)] as const));
    expect(moves.filter(([, , action]) => action === "approve")).toEqual([["writing", "ready", "approve"]]);
    expect(boardMove("rough", "ready")).toBeNull();
    expect(boardMove("writing", "rough")).toBeNull();
    expect(boardMove("ready", "writing")).toBeNull();
  });
});
