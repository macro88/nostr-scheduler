import { describe, expect, test } from "vitest";
import { plainError } from "../web/src/errors.ts";
import { formatWhen } from "../web/src/format.ts";

describe("formatWhen", () => {
  test("uses an en-GB 24-hour local time", () => {
    const date = new Date(2026, 10, 11, 14, 30);
    expect(formatWhen(date)).toBe("Wed 11 Nov, 14:30");
    expect(formatWhen(Math.floor(date.getTime() / 1000))).toBe("Wed 11 Nov, 14:30");
  });
});

describe("plainError", () => {
  test("hides technical failures behind a next step", () => {
    expect(plainError(new Error("refusing to sign a created_at in the past")).message).toBe(
      "That time has already passed. Choose a later time.",
    );
    expect(plainError(new Error("refusing to sign more than the sign-ahead horizon")).message).toContain("7 days");
    expect(plainError(new Error("no browser signer")).message).toContain("bunker");
    expect(plainError(new Error("Too small: expected string")).message).toContain("Check the text");
    expect(plainError(new Error("database exploded")).detail).toBe("database exploded");
    expect(plainError(new Error("database exploded")).message).not.toContain("exploded");
  });
});
