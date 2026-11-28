import { describe, expect, test } from "vitest";
import { InputError } from "../src/domain/brand.ts";
import { engagementOf, scoreOutlier } from "../src/research/score.ts";

describe("scoreOutlier", () => {
  test("divides a post by the author's baseline", () => {
    expect(scoreOutlier({ baselineEngagement: 2, postEngagement: 10 })).toBe(5);
    expect(scoreOutlier({ baselineEngagement: 4, postEngagement: 4 })).toBe(1);
    expect(scoreOutlier({ baselineEngagement: 2, postEngagement: 4 })).toBe(2);
  });

  test("uses the post count when the baseline is zero", () => {
    expect(scoreOutlier({ baselineEngagement: 0, postEngagement: 4 })).toBe(4);
    expect(scoreOutlier({ baselineEngagement: 0, postEngagement: 0 })).toBe(0);
  });

  test("rejects a negative or non-finite count", () => {
    expect(() => scoreOutlier({ baselineEngagement: -1, postEngagement: 1 })).toThrow(InputError);
    expect(() => scoreOutlier({ baselineEngagement: 1, postEngagement: Number.POSITIVE_INFINITY })).toThrow(InputError);
  });
});

describe("engagementOf", () => {
  test("adds replies, reposts, reactions, and zaps with equal weight", () => {
    expect(engagementOf({ replies: 2, reposts: 1, reactions: 4, zaps: 1 })).toBe(8);
    expect(engagementOf({ replies: 0, reposts: 0, reactions: 0, zaps: 0 })).toBe(0);
  });
});
