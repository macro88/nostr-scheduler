import { describe, expect, test } from "vitest";
import { formatWhen, localZoneLabel, zoneLabel } from "../web/src/format.ts";
import { statusWord } from "../web/src/labels.ts";

describe("local schedule words", () => {
  test("the zone label names the runtime zone without changing the clock text", () => {
    const sample = new Date("2026-11-19T03:10:00Z");
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
    const label = localZoneLabel(sample);
    expect(label).toBe(zoneLabel(zone, sample.getTimezoneOffset()));
    expect(label).not.toMatch(/UTC UTC/);
    expect(zoneLabel("UTC", 0)).toBe("UTC");
    expect(zoneLabel("Etc/UTC", 0)).toBe("UTC");
    expect(zoneLabel("Asia/Hong_Kong", -480)).toBe("Hong Kong UTC+08:00");
    expect(zoneLabel("America/Los_Angeles", 480)).toBe("Los Angeles UTC-08:00");
    expect(formatWhen(sample)).not.toContain("UTC");
  });

  test("an unsigned stored note is awaiting a signature, and a sent note is not", () => {
    expect(statusWord("approved")).toBe("Awaiting signature");
    expect(statusWord("queued")).toBe("Queued");
    expect(statusWord("sent")).toBe("Sent");
  });
});
