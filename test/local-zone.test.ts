import { describe, expect, test } from "vitest";
import { formatWhen, localZoneLabel } from "../web/src/format.ts";
import { statusWord } from "../web/src/labels.ts";

describe("local schedule words", () => {
  test("the zone label names the runtime zone without changing the clock text", () => {
    const sample = new Date("2026-11-19T03:10:00Z");
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
    const label = localZoneLabel(sample);
    expect(label.startsWith(`${zone} UTC`)).toBe(true);
    expect(label).toMatch(/UTC[+-]\d{2}:\d{2}$/);
    expect(formatWhen(sample)).not.toContain("UTC");
  });

  test("an unsigned stored note is awaiting a signature, and a sent note is not", () => {
    expect(statusWord("approved")).toBe("Awaiting signature");
    expect(statusWord("queued")).toBe("Queued");
    expect(statusWord("sent")).toBe("Sent");
  });
});
