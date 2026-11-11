import { describe, expect, test } from "vitest";
import { pushOnto } from "../web/src/toast-stack.ts";

describe("toast stack", () => {
  test("expires the oldest toast when a fourth one arrives", () => {
    const expired: string[] = [];
    const toast = (message: string) => ({
      id: message.length,
      kind: "undo" as const,
      message,
      onExpire: () => expired.push(message),
    });
    const kept = pushOnto([toast("one"), toast("two"), toast("three")], toast("four"));
    expect(expired).toEqual(["one"]);
    expect(kept.map((item) => item.message)).toEqual(["two", "three", "four"]);
  });
});
