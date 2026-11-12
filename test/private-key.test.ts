import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { scanText } from "../scripts/custody-check.mjs";
import { suggestionId, unixSeconds } from "../src/domain/brand.ts";
import { parseDraft } from "../src/domain/draft.ts";
import {
  containsPrivateKey,
  draftContainsPrivateKey,
  pasteCode,
  pasteWarning,
  PrivateKeyInContentError,
} from "../src/domain/private-key.ts";
import { createApp } from "../src/http/app.ts";
import { nextUnsigned } from "../src/http/sign-batch.ts";
import { callTool } from "../src/mcp/server.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { loadProfiles } from "../src/profiles/load.ts";
import { signApproved } from "../src/signers/batch.ts";
import type { Approved } from "../src/domain/types.ts";
import { WorkStore } from "../src/work/store.ts";

const fixture = "nsec1notarealkeyxxxxxxxx";
const now = unixSeconds(1_700_000_000);
const example = readFileSync(new URL("../examples/criteria/example-profile.md", import.meta.url), "utf8");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sched-key-"));
}

function writeProfile(dir: string, signer: ReturnType<typeof createMockSigner>) {
  const criteria = join(dir, "criteria.md");
  writeFileSync(criteria, example.replace("profile_id: example", "profile_id: demo"));
  const path = join(dir, "profiles.yaml");
  writeFileSync(
    path,
    [
      "profiles:",
      "  - id: demo",
      "    label: Demo",
      `    npub: ${signer.npub}`,
      `    pubkey: ${signer.pubkey}`,
      "    suggester_id: demo-suggester",
      "    signer:",
      "      kind: mock",
      "    relays:",
      "      - ws://127.0.0.1:9",
      "    read_nip65: false",
      "    criteria_path: criteria.md",
      "",
    ].join("\n"),
  );
  const profile = loadProfiles(path, { NOSTR_SCHEDULER_MODE: "test" })[0];
  if (!profile) throw new Error("missing profile");
  return profile;
}

async function authed(app: ReturnType<typeof createApp>["app"]) {
  const opened = await app.request("http://127.0.0.1:4173/api/session", { headers: { host: "127.0.0.1:4173" } });
  const body = (await opened.json()) as { token: string };
  const cookie = opened.headers.get("set-cookie")?.split(";")[0] ?? "";
  const headers = {
    host: "127.0.0.1:4173",
    origin: "http://127.0.0.1:4173",
    cookie,
    "x-csrf-token": body.token,
    "content-type": "application/json",
  };
  return {
    post: (path: string, payload: unknown) =>
      app.request(`http://127.0.0.1:4173${path}`, { method: "POST", headers, body: JSON.stringify(payload) }),
    get: (path: string) => app.request(`http://127.0.0.1:4173${path}`, { headers: { host: headers.host, cookie } }),
  };
}

function approved(content: string, profile: ReturnType<typeof writeProfile>): Approved {
  return {
    status: "approved",
    id: suggestionId("sug_keyguard1"),
    profileId: profile.id,
    suggesterId: profile.suggesterId,
    createdAt: now,
    approvedAt: now,
    draft: { type: "note", content, proposedFireAt: unixSeconds(now + 60) },
  };
}

describe("private key paste", () => {
  test("matches the prefix in any case and in the middle of other text", () => {
    expect(containsPrivateKey(fixture.toUpperCase())).toBe(true);
    expect(containsPrivateKey(fixture.replace(/^n/, "N"))).toBe(true);
    expect(containsPrivateKey(`prefix${fixture}suffix`)).toBe(true);
    expect(containsPrivateKey(`https://example.com/${fixture}/note`)).toBe(true);
    expect(containsPrivateKey("ship the relay table before the call")).toBe(false);
  });

  test("matches a later thread post or a reply and leaves a clean note alone", () => {
    expect(draftContainsPrivateKey({ type: "note", content: "a clean note" })).toBe(false);
    expect(
      draftContainsPrivateKey({
        type: "thread",
        segments: [{ content: "root stays clean" }, { content: `see ${fixture}` }],
      }),
    ).toBe(true);
    expect(draftContainsPrivateKey({ type: "reply", content: fixture })).toBe(true);
    expect(draftContainsPrivateKey({ type: "reply", content: "clean", parent: { content: fixture } })).toBe(true);
    expect(() => parseDraft({ type: "note", content: fixture, proposedFireAt: now + 60 })).toThrow(PrivateKeyInContentError);
    const clean = parseDraft({ type: "note", content: "a clean note", proposedFireAt: now + 60 });
    expect(clean).toMatchObject({ type: "note", content: "a clean note" });
  });

  test("the api refuses to store a draft, a suggestion, or an edit", async () => {
    const dir = tempDir();
    const { app, close } = createApp({ dataDir: dir, now: () => now });
    const signer = createMockSigner();
    writeProfile(dir, signer);
    const api = await authed(app);
    const before = readFileSync(join(dir, "app.sqlite"));
    const composed = await api.post("/api/compose", {
      profileId: "demo",
      draft: { type: "note", content: `hello ${fixture}`, proposedFireAt: now + 60 },
    });
    const composedBody = (await composed.json()) as { code?: string; error?: string };
    expect(composed.status).toBe(400);
    expect(composedBody.code).toBe(pasteCode);
    expect(composedBody.error).toBe(pasteWarning);
    expect(JSON.stringify(composedBody).includes(fixture)).toBe(false);
    const suggested = await api.post("/api/suggestions", {
      profileId: "demo",
      rationale: "saved",
      draft: { type: "thread", segments: [
        { content: "root stays clean", proposedFireAt: now + 60 },
        { content: fixture, proposedFireAt: now + 61 },
      ] },
    });
    expect(suggested.status).toBe(400);
    expect(((await suggested.json()) as { code?: string }).code).toBe(pasteCode);
    expect(readFileSync(join(dir, "app.sqlite")).equals(before)).toBe(true);
    const kept = await api.post("/api/suggestions", {
      profileId: "demo",
      rationale: "saved",
      draft: { type: "note", content: "a clean note", proposedFireAt: now + 60 },
    });
    const saved = (await kept.json()) as { id: string; preview: string };
    expect(kept.status).toBe(200);
    const edited = await api.post(`/api/items/${saved.id}/edit`, {
      draft: { type: "reply", content: fixture, proposedFireAt: now + 60, target: {
        eventId: "ab".repeat(32),
        rootId: "ab".repeat(32),
        pubkey: "cd".repeat(32),
      } },
    });
    expect(edited.status).toBe(400);
    const items = (await (await api.get("/api/items?profileId=demo")).json()) as { id: string; preview: string }[];
    expect(items).toEqual([expect.objectContaining({ id: saved.id, preview: "a clean note" })]);
    close();
  });

  test("signing never asks the signer, and suggest_post stores nothing", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    const profile = writeProfile(dir, signer);
    let calls = 0;
    const guarded = {
      ...signer,
      signEvent: async (event: Parameters<typeof signer.signEvent>[0]) => {
        calls += 1;
        return signer.signEvent(event);
      },
    };
    await expect(
      signApproved({
        signer: guarded,
        item: approved(`note ${fixture}`, profile),
        now,
        maxAheadSeconds: 7 * 24 * 60 * 60,
        relayHint: profile.relays.configured[0],
      }),
    ).rejects.toMatchObject({ code: pasteCode });
    expect(calls).toBe(0);
    expect(() =>
      nextUnsigned({ item: approved(fixture, profile), profile, signedSoFar: [], now }),
    ).toThrow(PrivateKeyInContentError);
    const clean = await signApproved({
      signer: guarded,
      item: approved("a clean note", profile),
      now,
      maxAheadSeconds: 7 * 24 * 60 * 60,
      relayHint: profile.relays.configured[0],
    });
    expect(clean.events).toHaveLength(1);
    expect(calls).toBe(1);

    const store = new WorkStore(join(dir, "app.sqlite"));
    const before = readFileSync(join(dir, "app.sqlite"));
    await expect(
      callTool({ profiles: [profile], store, now: () => now }, "suggest_post", {
        profileId: "demo",
        suggesterId: "demo-suggester",
        rationale: "because",
        draft: { type: "note", content: fixture, proposedFireAt: now + 30 },
      }),
    ).rejects.toMatchObject({ code: pasteCode });
    expect(readFileSync(join(dir, "app.sqlite")).equals(before)).toBe(true);
    expect(store.list()).toEqual([]);
    store.close();
  });

  test("custody still fails when note text containing the prefix would be written", () => {
    expect(scanText("src/domain/private-key.ts", readFileSync(new URL("../src/domain/private-key.ts", import.meta.url), "utf8"))).toEqual([]);
    const prefix = ["ns", "ec1"].join("");
    expect(scanText("src/leak.ts", fixture)).toContain(prefix);
    expect(scanText("src/leak.ts", `writeFileSync("note.txt", ${JSON.stringify(fixture)})`)).toContain("persisted-marker");
  });
});
