import { describe, expect, test } from "vitest";
import { InputError } from "../src/domain/brand.ts";
import { assignPerformanceBands, type PerformanceRank } from "../src/research/performance.ts";

const fixture: readonly PerformanceRank[] = [
  { eventId: "n01", createdAt: 1, multiplier: 1 },
  { eventId: "n02", createdAt: 2, multiplier: 2 },
  { eventId: "n03", createdAt: 3, multiplier: 2 },
  { eventId: "n04", createdAt: 4, multiplier: 4 },
  { eventId: "n05", createdAt: 5, multiplier: 5 },
  { eventId: "n06", createdAt: 6, multiplier: 6 },
  { eventId: "n07", createdAt: 7, multiplier: 7 },
  { eventId: "n08", createdAt: 8, multiplier: 9 },
  { eventId: "n09", createdAt: 9, multiplier: 9 },
  { eventId: "n10", createdAt: 10, multiplier: 10 },
];

describe("assignPerformanceBands", () => {
  test("cuts the top and bottom 20% on a fixed list, and a tie stays outside the slice", () => {
    const original = fixture.map((note) => ({ ...note }));
    const bands = assignPerformanceBands(original);
    expect(bands.fraction).toBe(0.2);
    expect(bands.topCutoff).toBe(9);
    expect(bands.bottomCutoff).toBe(2);
    expect(bands.notes.filter((note) => note.label === "Do more").map((note) => note.eventId)).toEqual(["n10", "n09"]);
    expect(bands.notes.filter((note) => note.label === "Do less").map((note) => note.eventId)).toEqual(["n02", "n01"]);
    expect(bands.notes.find((note) => note.eventId === "n08")).toMatchObject({ multiplier: 9, band: "middle", label: null });
    expect(bands.notes.find((note) => note.eventId === "n03")).toMatchObject({ multiplier: 2, band: "middle", label: null });
    expect(original.map((note) => note.eventId)).toEqual(fixture.map((note) => note.eventId));
  });

  test("leaves every note in the middle when the list is shorter than five", () => {
    const bands = assignPerformanceBands([
      { eventId: "a", createdAt: 1, multiplier: 1 },
      { eventId: "b", createdAt: 2, multiplier: 4 },
      { eventId: "c", createdAt: 3, multiplier: 2 },
      { eventId: "d", createdAt: 4, multiplier: 3 },
    ]);
    expect(bands.topCutoff).toBeNull();
    expect(bands.bottomCutoff).toBeNull();
    expect(bands.notes.every((note) => note.band === "middle" && note.label === null)).toBe(true);
    expect(bands.notes.map((note) => note.eventId)).toEqual(["b", "d", "c", "a"]);
  });

  test("marks one note on each end of a five note list", () => {
    const bands = assignPerformanceBands([
      { eventId: "a", createdAt: 1, multiplier: 1 },
      { eventId: "b", createdAt: 2, multiplier: 2 },
      { eventId: "c", createdAt: 3, multiplier: 3 },
      { eventId: "d", createdAt: 4, multiplier: 4 },
      { eventId: "e", createdAt: 5, multiplier: 5 },
    ]);
    expect(bands.topCutoff).toBe(5);
    expect(bands.bottomCutoff).toBe(1);
    expect(bands.notes[0]).toMatchObject({ eventId: "e", label: "Do more" });
    expect(bands.notes[4]).toMatchObject({ eventId: "a", label: "Do less" });
    expect(bands.notes.slice(1, 4).every((note) => note.label === null)).toBe(true);
  });

  test("rejects a negative multiplier", () => {
    expect(() => assignPerformanceBands([{ eventId: "a", createdAt: 1, multiplier: -1 }])).toThrow(InputError);
  });
});
