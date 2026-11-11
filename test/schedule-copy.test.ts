import { describe, expect, test } from "vitest";
import { weekExcerpt } from "../web/src/excerpt.ts";
import { formatQueueWhen } from "../web/src/format.ts";

const frozen = new Date(2026, 10, 11, 15, 5, 0);

function at(day: number, hour: number, minute: number): number {
  return Math.floor(new Date(2026, 10, day, hour, minute, 0).getTime() / 1000);
}

describe("schedule dates", () => {
  test("today, tomorrow, and a later day", () => {
    expect(formatQueueWhen(at(11, 9, 0), frozen)).toBe("Today, 09:00");
    expect(formatQueueWhen(at(12, 11, 0), frozen)).toBe("Tomorrow, 11:00");
    expect(formatQueueWhen(at(13, 11, 0), frozen)).toBe("Fri 13 Nov, 11:00");
  });

  test("midnight keeps today and tomorrow on the calendar day", () => {
    const late = new Date(2026, 10, 11, 23, 50, 0);
    expect(formatQueueWhen(at(11, 23, 59), late)).toBe("Today, 23:59");
    expect(formatQueueWhen(at(12, 0, 10), late)).toBe("Tomorrow, 00:10");
    expect(formatQueueWhen(at(13, 0, 10), late)).toBe("Fri 13 Nov, 00:10");
  });
});

describe("week excerpt", () => {
  test("an empty note has no excerpt", () => {
    expect(weekExcerpt("")).toBe("");
    expect(weekExcerpt("   \nlater")).toBe("");
  });

  test("markdown on the first line is stripped", () => {
    expect(weekExcerpt("**ship** the [table](https://example.test) now")).toBe("ship the table now");
  });

  test("only the first line remains, with whitespace collapsed", () => {
    expect(weekExcerpt("  back   tomorrow  \nmore")).toBe("back tomorrow");
  });
});
