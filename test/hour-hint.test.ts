import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { InputError, profileId } from "../src/domain/brand.ts";
import { cadenceOf } from "../src/http/profile-view.ts";
import { hintHours, hourHintText, type EngagementTiming } from "../src/research/hints.ts";

const utc = (iso: string) => Date.parse(iso) / 1000;

const winner: readonly EngagementTiming[] = [
  { createdAt: utc("2024-01-15T09:00:00Z"), engagement: 1 },
  { createdAt: utc("2024-01-16T09:30:00Z"), engagement: 2 },
  { createdAt: utc("2024-01-15T18:00:00Z"), engagement: 4 },
  { createdAt: utc("2024-01-17T03:00:00Z"), engagement: 1 },
];

describe("hintHours", () => {
  test("names the UTC hour with the most engagement", () => {
    expect(hintHours(winner, "UTC")).toEqual({ timezone: "UTC", hours: [18] });
  });

  test("includes every hour tied for the most engagement, in clock order", () => {
    const tied: readonly EngagementTiming[] = [
      { createdAt: utc("2024-01-15T18:00:00Z"), engagement: 4 },
      { createdAt: utc("2024-01-15T09:00:00Z"), engagement: 4 },
      { createdAt: utc("2024-01-15T03:00:00Z"), engagement: 1 },
    ];
    expect(hintHours(tied, "UTC")).toEqual({ timezone: "UTC", hours: [9, 18] });
  });

  test("reads the hour in the given time zone", () => {
    const morning = [{ createdAt: utc("2024-01-15T01:00:00Z"), engagement: 5 }];
    expect(hintHours(morning, "Asia/Hong_Kong")).toEqual({ timezone: "Asia/Hong_Kong", hours: [9] });
    expect(hintHours(morning, "UTC")).toEqual({ timezone: "UTC", hours: [1] });
  });

  test("returns no hint when there are no notes or no engagement", () => {
    expect(hintHours([], "UTC")).toBeNull();
    expect(hintHours([{ createdAt: utc("2024-01-15T09:00:00Z"), engagement: 0 }], "UTC")).toBeNull();
  });

  test("returns no hint when more than three hours tie", () => {
    const flat = [1, 2, 3, 4].map((hour) => ({
      createdAt: utc(`2024-01-15T${String(hour).padStart(2, "0")}:00:00Z`),
      engagement: 2,
    }));
    expect(hintHours(flat, "UTC")).toBeNull();
  });

  test("rejects a bad time zone and a negative engagement", () => {
    expect(() => hintHours(winner, "Not/AZone")).toThrow(InputError);
    expect(() => hintHours([{ createdAt: utc("2024-01-15T09:00:00Z"), engagement: -1 }], "UTC")).toThrow(InputError);
  });

  test("leaves the note list and criteria hours unchanged", () => {
    const notes = winner.map((note) => ({ ...note }));
    const before = JSON.stringify(notes);
    const preferred = [9, 18];
    const text = hourHintText({ notes, timezone: "UTC", preferredHours: preferred });
    expect(JSON.stringify(notes)).toBe(before);
    expect(preferred).toEqual([9, 18]);
    expect(text).toBe(
      "Public notes got the most replies, reposts, reactions, and zaps around 18:00 in UTC. Criteria hours stay 09:00 and 18:00 until you edit them.",
    );
  });

  test("omits the criteria sentence when the profile has no criteria", () => {
    expect(hourHintText({ notes: winner, timezone: "UTC", preferredHours: null })).toBe(
      "Public notes got the most replies, reposts, reactions, and zaps around 18:00 in UTC.",
    );
    expect(hourHintText({ notes: winner, timezone: "UTC", preferredHours: [] })).toBe(
      "Public notes got the most replies, reposts, reactions, and zaps around 18:00 in UTC. Criteria hours stay unset until you edit them.",
    );
  });

});

describe("cadenceOf", () => {
  test("reads preferred hours and leaves the criteria file unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "hour-hint-criteria-"));
    const path = join(dir, "demo.md");
    const source = ["---", "profile_id: demo", 'version: "1"', "timezone: UTC", "posts_per_day: 1", "preferred_hours: [9, 18]", "post_types: [note]", "topics:", "  - notes", "no_go_topics: []", "sources: []", "---", "", "# Voice", "", "Short.", "", "# Reply rules", "", "Public notes only.", "", "# Good examples", "", "- A short note.", "", "# Bad examples", "", "- A slogan.", ""].join("\n");
    writeFileSync(path, source);
    const profile = { id: profileId("demo"), criteriaPath: path };
    const cadence = cadenceOf(profile);
    expect(cadence).toEqual({ timezone: "UTC", preferredHours: [9, 18] });
    expect(readFileSync(path, "utf8")).toBe(source);
    expect(cadenceOf({ id: profileId("demo"), criteriaPath: null })).toBeNull();
    expect(cadenceOf({ id: profileId("demo"), criteriaPath: join(dir, "missing.md") })).toBeNull();
    const broken = join(dir, "broken.md");
    writeFileSync(broken, "not criteria");
    expect(cadenceOf({ id: profileId("demo"), criteriaPath: broken })).toBeNull();
    expect(readFileSync(broken, "utf8")).toBe("not criteria");
  });
});

function summarize(samples: readonly number[]): { median: number; min: number; max: number } {
  const ordered = [...samples].sort((left, right) => left - right);
  return { median: ordered[2] ?? 0, min: ordered[0] ?? 0, max: ordered[4] ?? 0 };
}

describe("hint compute", () => {
  test("finishes 100 cached notes in under 20 ms", () => {
    const day = Date.UTC(2024, 0, 15, 0, 0, 0) / 1000;
    const notes: EngagementTiming[] = [
      ...Array.from({ length: 60 }, (_, index) => ({ createdAt: day + 9 * 3600 + index, engagement: 1 })),
      ...Array.from({ length: 40 }, (_, index) => ({ createdAt: day + 18 * 3600 + index, engagement: 5 })),
    ];
    const warmup = hintHours(notes, "UTC");
    expect(warmup).toEqual({ timezone: "UTC", hours: [18] });
    const format = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", hourCycle: "h23" });
    const formatSamples: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const formatStart = performance.now();
      let sink = 0;
      for (const note of notes) {
        sink += Number(format.formatToParts(new Date(note.createdAt * 1000)).find((part) => part.type === "hour")?.value ?? 0);
      }
      formatSamples.push(performance.now() - formatStart);
      if (sink <= 0) throw new Error("hour formatting did not run");
    }
    const formatMs = summarize(formatSamples);
    const samples: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const start = performance.now();
      const hint = hintHours(notes, "UTC");
      const elapsed = performance.now() - start;
      if (hint?.hours.length !== 1 || hint.hours[0] !== 18 || hint.timezone !== "UTC") {
        throw new Error("timed hint did not rank the cached notes");
      }
      samples.push(elapsed);
    }
    const summary = summarize(samples);
    const report = {
      claim: "hintHours on 100 cached notes, median under 20 ms, fail above 100 ms",
      unit: "ms",
      notes: notes.length,
      runs: samples,
      summary,
      formatToPartsMs: formatMs,
      limiter: formatMs.median >= summary.median * 0.5 ? "Intl.DateTimeFormat.formatToParts" : "hour ranking",
      loadavg: loadavg(),
      cores: availableParallelism(),
      errors: 0,
    };
    mkdirSync("/opt/cursor/artifacts", { recursive: true });
    writeFileSync("/opt/cursor/artifacts/hour-hint-bench.json", `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
    expect(summary.max, "fail above 100 ms").toBeLessThan(100);
    expect(summary.median, "cached hint stays under 20 ms").toBeLessThan(20);
  });
});
