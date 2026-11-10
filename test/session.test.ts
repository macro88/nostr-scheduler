import { chmodSync, mkdtempSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createSession, fileSessionWarning, loadOrCreateSession, wipeSession, writeLegacySessionFile } from "../src/signers/nip46-session.ts";
import { memorySessionStore } from "../src/signers/session-store.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sched-session-"));
}

describe("session storage", () => {
  test("keeps the same session in the memory keychain and removes it on wipe", () => {
    const dir = tempDir();
    const store = memorySessionStore();
    const first = loadOrCreateSession(dir, { store, keychain: () => null });
    const second = loadOrCreateSession(dir, { store, keychain: () => null });
    expect(second.pubkey).toBe(first.pubkey);
    expect(existsSync(join(dir, "client.json"))).toBe(false);
    wipeSession(dir, { store });
    const third = loadOrCreateSession(dir, { store, keychain: () => null });
    expect(third.pubkey).not.toBe(first.pubkey);
    expect(store.read()).not.toBe(null);
  });

  test("moves an existing file into the keychain and deletes the file", () => {
    const dir = tempDir();
    const created = createSession();
    const path = writeLegacySessionFile(dir, created);
    chmodSync(path, 0o644);
    const store = memorySessionStore();
    const loaded = loadOrCreateSession(dir, { store, keychain: () => null });
    expect(loaded.pubkey).toBe(created.pubkey);
    expect(existsSync(path)).toBe(false);
    expect(store.read()).not.toBe(null);
  });

  test("refuses file storage unless it is explicitly allowed", () => {
    const dir = tempDir();
    expect(() => loadOrCreateSession(dir, { keychain: () => null, allowFile: false })).toThrow(/keychain/);
    const warnings: string[] = [];
    const session = loadOrCreateSession(dir, {
      keychain: () => null,
      allowFile: true,
      warn: (message) => warnings.push(message),
    });
    const path = join(dir, "client.json");
    expect(warnings).toEqual([fileSessionWarning(path)]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = loadOrCreateSession(dir, {
      keychain: () => null,
      allowFile: true,
      warn: () => undefined,
    });
    expect(again.pubkey).toBe(session.pubkey);
  });
});
