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
      "This time is in the past. Choose a time from now on.",
    );
    expect(plainError(new Error("refusing to sign more than the sign-ahead horizon")).message).toBe(
      "This time is further ahead than you can sign. Choose a time within the next seven days.",
    );
    expect(plainError(new Error("the time is frozen")).message).toBe(
      "This event is signed, so the time is frozen. Discard it and sign again to choose a new time.",
    );
    expect(plainError(new Error("no browser signer")).message).toBe(
      "No browser signer is available. Pair a bunker, or install a signer for this page.",
    );
    expect(plainError(new Error("the signer did not respond")).message).toBe(
      "The signer did not respond. Try again, or use a bunker.",
    );
    expect(plainError(new Error("bad bunker link")).message).toBe("This bunker link is not valid.");
    expect(plainError(new Error("the relay timed out")).message).toBe("Publishing failed on every relay.");
    expect(plainError(new Error("Too small: expected string")).message).toBe("Check the text and the time, then try again.");
    expect(plainError(new Error("database exploded")).detail).toBe("database exploded");
    expect(plainError(new Error("database exploded")).message).toBe("That change could not be saved. Try again.");
  });
});
