import { describe, expect, test } from "vitest";
import { readShortcutsEnabled, singleKeyActive, typingTarget, writeShortcutsEnabled } from "../web/src/keys.ts";

describe("single-key shortcuts", () => {
  test("stay off when the page has stored that choice", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    expect(readShortcutsEnabled(storage)).toBe(true);
    writeShortcutsEnabled(storage, false);
    expect(readShortcutsEnabled(storage)).toBe(false);
    writeShortcutsEnabled(storage, true);
    expect(readShortcutsEnabled(storage)).toBe(true);
  });

  test("ignore a key while text, a select, or editable content has focus", () => {
    expect(typingTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(typingTarget({ tagName: "INPUT", type: "datetime-local" })).toBe(true);
    expect(typingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(typingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(typingTarget({ tagName: "SELECT" })).toBe(true);
    expect(typingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(typingTarget({ tagName: "ARTICLE" })).toBe(false);
    expect(singleKeyActive(true, { tagName: "ARTICLE" })).toBe(true);
    expect(singleKeyActive(false, { tagName: "ARTICLE" })).toBe(false);
    expect(singleKeyActive(true, { tagName: "SELECT" })).toBe(false);
  });
});
