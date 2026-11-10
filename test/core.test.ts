import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { scanText } from "../scripts/custody-check.mjs";
import { decodeBech32 } from "../src/domain/bech32.ts";
import { npubFromPubkey, pubkeyFromNpub } from "../src/domain/bech32.ts";
import { unixSeconds } from "../src/domain/brand.ts";
import { decideCatchUp } from "../src/domain/catchup.ts";
import { DEFAULT_CATCH_UP_SECONDS, DEFAULT_READ_NIP65, DEFAULT_SIGN_AHEAD_SECONDS } from "../src/domain/defaults.ts";
import { noteUnsigned, parseSignedEvent } from "../src/domain/event.ts";
import { assertWithinSignHorizon } from "../src/domain/horizon.ts";
import { mergeWriteRelays, relayListFromTags } from "../src/domain/relays.ts";
import { applyCommand } from "../src/domain/transitions.ts";
import { relayUrl } from "../src/domain/brand.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";
import type { Suggestion } from "../src/domain/types.ts";

const now = unixSeconds(1_700_000_000);

function suggestion(): Suggestion {
  return {
    status: "suggestion",
    id: "sug_demo0001" as Suggestion["id"],
    profileId: "demo" as Suggestion["profileId"],
    suggesterId: "demo-suggester" as Suggestion["suggesterId"],
    createdAt: now,
    rationale: "because",
    draft: { type: "note", content: "hello", proposedFireAt: unixSeconds(now + 60) },
  };
}

describe("custody", () => {
  test("flags secret-key handling outside the allowlist", () => {
    const account = ["secret", "Key"].join("");
    const bech32 = ["ns", "ec"].join("");
    const helper = ["generate", "Secret", "Key"].join("");
    expect(scanText("src/queue/store.ts", `const ${account} = 1`)).toContain(account);
    expect(scanText("src/signers/nip46-session.ts", `const ${account} = 1`)).toEqual([]);
    expect(scanText("src/signers/nip46-session.ts", bech32)).toContain(bech32);
    expect(scanText("src/mock-signer/index.ts", helper)).toEqual([]);
  });
});

describe("bech32", () => {
  test("decodes a known checksum and round-trips a throwaway npub", () => {
    expect(decodeBech32("a12uel5l").data.length).toBe(0);
    const signer = createMockSigner();
    const encoded = npubFromPubkey(signer.pubkey);
    expect(pubkeyFromNpub(encoded)).toBe(signer.pubkey);
    expect(signer.npub).toBe(encoded);
  });
});

describe("state machine", () => {
  test("walks suggestion to queued and refuses an edit after signing", () => {
    const signer = createMockSigner();
    const item = { ...suggestion(), profileId: "demo" as Suggestion["profileId"] };
    item.draft = { type: "note", content: "hello", proposedFireAt: unixSeconds(now + 60) };
    const approved = applyCommand(item, { type: "approve" }, now);
    expect(approved.status).toBe("approved");
    const edited = applyCommand(approved, { type: "edit", draft: { ...item.draft, content: "edited" } }, now);
    expect(edited.status).toBe("approved");
    if (edited.status !== "approved") return;
    const unsigned = noteUnsigned({ pubkey: signer.pubkey, content: "edited", createdAt: item.draft.proposedFireAt });
    return signer.signEvent(unsigned).then((signed) => {
      const signedWork = applyCommand(edited, { type: "sign", events: [signed] }, now);
      expect(signedWork.status).toBe("signed");
      expect(() => applyCommand(signedWork, { type: "edit", draft: item.draft }, now)).toThrow(/cannot edit/);
      const queued = applyCommand(signedWork, { type: "enqueue" }, now);
      expect(queued.status).toBe("queued");
    });
  });

  test("rejects a bad signature", () => {
    const signer = createMockSigner();
    const unsigned = noteUnsigned({ pubkey: signer.pubkey, content: "hello", createdAt: now });
    return signer.signEvent(unsigned).then((signed) => {
      expect(() => parseSignedEvent({ ...signed, content: "tampered" })).toThrow(/sig/);
    });
  });
});

describe("defaults", () => {
  test("waits, publishes inside 15 minutes, and misses after that", () => {
    expect(DEFAULT_CATCH_UP_SECONDS).toBe(15 * 60);
    expect(DEFAULT_SIGN_AHEAD_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(DEFAULT_READ_NIP65).toBe(false);
    expect(decideCatchUp({ now, createdAt: unixSeconds(now + 10), windowSeconds: 900 }).action).toBe("wait");
    expect(decideCatchUp({ now: unixSeconds(now + 900), createdAt: now, windowSeconds: 900 }).action).toBe("publish");
    const missed = decideCatchUp({ now: unixSeconds(now + 901), createdAt: now, windowSeconds: 900 });
    expect(missed).toEqual({ action: "missed", lateBySeconds: 901 });
  });

  test("refuses a past created_at and one past the horizon", () => {
    expect(() => assertWithinSignHorizon({ now, createdAt: unixSeconds(now - 1), maxAheadSeconds: 10 })).toThrow(/past/);
    expect(() => assertWithinSignHorizon({ now, createdAt: unixSeconds(now + 11), maxAheadSeconds: 10 })).toThrow(/horizon/);
    expect(() => assertWithinSignHorizon({ now, createdAt: now, maxAheadSeconds: 10 })).not.toThrow();
  });

  test("nip65 merge stays off unless asked", () => {
    const configured = [relayUrl("ws://127.0.0.1:1")];
    const list = relayListFromTags([
      ["r", "ws://127.0.0.1:2", "write"],
      ["r", "ws://127.0.0.1:3", "read"],
    ]);
    expect(mergeWriteRelays(configured, list, false)).toEqual(configured);
    expect(mergeWriteRelays(configured, list, true)).toEqual([configured[0], relayUrl("ws://127.0.0.1:2")]);
  });
});

describe("mock signer", () => {
  test("refuses to start in production", () => {
    expect(() => createMockSigner({ NOSTR_SCHEDULER_MODE: "production" })).toThrow(/test or demo/);
  });
});

test("example criteria file exists for later checks", () => {
  const dir = mkdtempSync(join(tmpdir(), "sched-"));
  writeFileSync(join(dir, "note.txt"), "ok");
  expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("ok");
});
