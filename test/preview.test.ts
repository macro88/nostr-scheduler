import { describe, expect, test } from "vitest";
import { previewParts } from "../web/src/preview.ts";

describe("previewParts", () => {
  test("projects the note the operator is typing", () => {
    expect(previewParts({ kind: "note", note: "Alpha note" })).toEqual({ lines: ["Alpha note"] });
    expect(previewParts({ kind: "note", note: "Alpha\nBeta" })).toEqual({ lines: ["Alpha\nBeta"] });
    expect(previewParts({ kind: "note", note: "  spaced" })).toEqual({ lines: ["  spaced"] });
    expect(previewParts({ kind: "note", note: "" })).toEqual({ lines: [] });
  });

  test("projects each thread part, including a blank between posts", () => {
    expect(previewParts({ kind: "thread", parts: ["Root line", "Next line"] })).toEqual({
      lines: ["Root line", "Next line"],
    });
    expect(previewParts({ kind: "thread", parts: ["Root line", ""] })).toEqual({ lines: ["Root line", ""] });
    expect(previewParts({ kind: "thread", parts: ["", ""] })).toEqual({ lines: [] });
  });

  test("projects the reply the operator is typing", () => {
    expect(previewParts({ kind: "reply", reply: "Thanks" })).toEqual({ lines: ["Thanks"] });
    expect(previewParts({ kind: "reply", reply: "" })).toEqual({ lines: [] });
  });
});
