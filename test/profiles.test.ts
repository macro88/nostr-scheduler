import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { unixSeconds } from "../src/domain/brand.ts";
import { pubkeyFromNpub, npubFromPubkey } from "../src/domain/bech32.ts";
import { npub as npubBrand } from "../src/domain/brand.ts";
import { createApp } from "../src/http/app.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { loadProfiles } from "../src/profiles/load.ts";
import { publishDue } from "../src/publisher/publish.ts";
import { LocalRelay } from "../src/test-relay/relay.ts";
import { fetchFromRelay } from "../src/test-relay/client.ts";

const example = readFileSync(new URL("../examples/criteria/example-profile.md", import.meta.url), "utf8");
const fixture = "nsec1notarealkeyxxxxxxxx";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sched-profile-"));
}

function criteria(dir: string, id = "demo") {
  writeFileSync(join(dir, "criteria.md"), example.replace("profile_id: example", `profile_id: ${id}`));
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
    headers,
    send: (method: string, path: string, payload?: unknown) =>
      app.request(`http://127.0.0.1:4173${path}`, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
      }),
  };
}

function bodyOf(signer = createMockSigner(), relay = "ws://127.0.0.1:9", extra: Record<string, unknown> = {}) {
  return {
    label: "Desk",
    npub: signer.npub,
    signer: { kind: "nip07" },
    criteriaPath: "criteria.md",
    relays: [relay],
    ...extra,
  };
}

describe("profiles", () => {
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  const logs: string[] = [];

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
    logs.length = 0;
  });

  function watchConsole() {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      spies.push(vi.spyOn(console, method).mockImplementation((...args: unknown[]) => logs.push(args.map(String).join(" "))));
    }
  }

  test("decodes an npub and rejects hex or an invalid npub", async () => {
    const dir = tempDir();
    criteria(dir);
    const signer = createMockSigner();
    const { app, close } = createApp({ dataDir: dir });
    const api = await authed(app);
    const created = await api.send("POST", "/api/profiles", bodyOf(signer));
    const saved = (await created.json()) as { pubkey: string; npub: string; error?: string };
    expect(created.status).toBe(201);
    expect(saved.npub).toBe(signer.npub);
    expect(saved.pubkey).toBe(pubkeyFromNpub(npubBrand(signer.npub)));
    expect(saved.pubkey).toBe(signer.pubkey);
    const hex = await api.send("POST", "/api/profiles", { ...bodyOf(signer), label: "Hex", npub: signer.pubkey });
    const hexBody = await hex.json();
    expect(hex.status).toBe(400);
    expect(JSON.stringify(hexBody)).toContain("hex key");
    expect(JSON.stringify(hexBody)).not.toContain(signer.pubkey);
    const broken = await api.send("POST", "/api/profiles", { ...bodyOf(signer), label: "Broken", npub: "npub1notakey" });
    expect(broken.status).toBe(400);
    expect(JSON.stringify(await broken.json())).toContain("isn't an npub");
    close();
  });

  test("refuses a private-key marker before writing", async () => {
    const dir = tempDir();
    criteria(dir);
    watchConsole();
    const { app, close } = createApp({ dataDir: dir });
    const api = await authed(app);
    const refused = await api.send("POST", "/api/profiles", { ...bodyOf(), label: `name ${fixture}` });
    const text = JSON.stringify(await refused.json());
    expect(refused.status).toBe(400);
    expect(text).not.toContain(fixture);
    expect(logs.join("\n")).not.toContain(fixture);
    const file = existsSync(join(dir, "profiles.yaml")) ? readFileSync(join(dir, "profiles.yaml"), "utf8") : "";
    expect(file).not.toContain(fixture);
    close();
  });

  test("flags a public publish relay unless the profile opts in", async () => {
    const dir = tempDir();
    criteria(dir);
    const signer = createMockSigner();
    const { app, close } = createApp({ dataDir: dir });
    const api = await authed(app);
    const blocked = await api.send("POST", "/api/profiles", bodyOf(signer, "wss://relay.example"));
    const blockedBody = (await blocked.json()) as { id: string; relays: { url: string; publish: boolean; flagged: boolean }[] };
    expect(blocked.status).toBe(201);
    expect(blockedBody.relays[0]).toMatchObject({ url: "wss://relay.example", publish: false, flagged: true });
    const loaded = loadProfiles(join(dir, "profiles.yaml"), { NOSTR_SCHEDULER_MODE: "test" })[0];
    expect(loaded?.relays.configured).toEqual([]);
    const allowed = await api.send("PATCH", `/api/profiles/${blockedBody.id}`, {
      ...bodyOf(signer, "wss://relay.example"),
      allowPublicRelays: true,
    });
    const allowedBody = (await allowed.json()) as { relays: { publish: boolean }[] };
    expect(allowedBody.relays[0]?.publish).toBe(true);
    const loopback = await api.send("POST", "/api/profiles", { ...bodyOf(createMockSigner(), "ws://localhost:9"), label: "Local" });
    expect(loopback.status).toBe(201);
    const v6 = await api.send("POST", "/api/profiles", { ...bodyOf(createMockSigner(), "ws://[::1]:4242"), label: "V6" });
    const v6Body = (await v6.json()) as { relays: { publish: boolean; public: boolean }[] };
    expect(v6.status, JSON.stringify(v6Body)).toBe(201);
    expect(v6Body.relays[0]).toMatchObject({ publish: true, public: false });
    close();
  });

  test("a hand-edited public relay is not a publish target", async () => {
    const dir = tempDir();
    criteria(dir, "demo");
    const signer = createMockSigner();
    const when = 1_700_000_060;
    writeFileSync(
      join(dir, "profiles.yaml"),
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
        "      - wss://relay.example",
        "    criteria_path: criteria.md",
        "",
      ].join("\n"),
    );
    const profile = loadProfiles(join(dir, "profiles.yaml"), { NOSTR_SCHEDULER_MODE: "test" })[0];
    expect(profile?.relays.allowPublicRelays).toBe(false);
    expect(profile?.relays.configured).toEqual([]);
    expect(profile?.relays.listed[0]?.flagged).toBe(true);
    const { store, close } = createApp({ dataDir: dir, now: () => unixSeconds(when) });
    if (!profile) throw new Error("missing profile");
    const suggested = store.suggest({
      profile,
      suggesterId: profile.suggesterId,
      draft: { type: "note", content: "queued note", proposedFireAt: unixSeconds(when) },
      rationale: "because",
      at: unixSeconds(when - 10),
    });
    store.transition(suggested.id, { type: "approve" }, unixSeconds(when - 5), profile);
    const approved = store.get(suggested.id);
    if (approved.status !== "approved") throw new Error("not approved");
    const signed = await signer.signEvent({
      kind: 1,
      pubkey: signer.pubkey,
      created_at: unixSeconds(when),
      tags: [],
      content: "queued note",
    });
    store.transition(suggested.id, { type: "sign", events: [signed] }, unixSeconds(when));
    store.transition(suggested.id, { type: "enqueue" }, unixSeconds(when));
    const calls: string[] = [];
    await publishDue({
      store,
      profiles: loadProfiles(join(dir, "profiles.yaml"), { NOSTR_SCHEDULER_MODE: "test" }),
      transport: {
        publish: async (relay) => {
          calls.push(relay);
          return { relay, accepted: true, message: "" };
        },
      },
      now: () => unixSeconds(when),
      windowSeconds: 60,
      sleep: async () => undefined,
      delays: [],
    });
    expect(calls).toEqual([]);
    close();
  });

  test("keeps unknown yaml fields across an update", async () => {
    const dir = tempDir();
    criteria(dir);
    const signer = createMockSigner();
    writeFileSync(
      join(dir, "profiles.yaml"),
      [
        "owner: kept",
        "profiles:",
        "  - id: desk",
        "    label: Desk",
        "    note: keep-me",
        `    npub: ${signer.npub}`,
        `    pubkey: ${signer.pubkey}`,
        "    suggester_id: desk-suggester",
        "    signer:",
        "      kind: nip07",
        "    relays:",
        "      - ws://127.0.0.1:9",
        "    criteria_path: criteria.md",
        "",
      ].join("\n"),
    );
    const { app, close } = createApp({ dataDir: dir });
    const api = await authed(app);
    const updated = await api.send("PATCH", "/api/profiles/desk", { ...bodyOf(signer), label: "Renamed" });
    expect(updated.status).toBe(200);
    const file = readFileSync(join(dir, "profiles.yaml"), "utf8");
    expect(file).toContain("owner: kept");
    expect(file).toContain("note: keep-me");
    expect(file).toContain("label: Renamed");
    expect(file).not.toContain(".tmp");
    close();
  });

  test("rejects a criteria path that leaves the data directory", async () => {
    const dir = tempDir();
    criteria(dir);
    const { app, close } = createApp({ dataDir: dir });
    const api = await authed(app);
    const escaped = await api.send("POST", "/api/profiles", { ...bodyOf(), criteriaPath: "../outside.md" });
    expect(escaped.status).toBe(400);
    expect(JSON.stringify(await escaped.json())).toContain("data directory");
    const absolute = await api.send("POST", "/api/profiles", { ...bodyOf(), criteriaPath: "/etc/passwd" });
    expect(absolute.status).toBe(400);
    close();
  });

  test("discards queued and signed notes when a profile is removed, and confirms an empty profile", async () => {
    const dir = tempDir();
    criteria(dir);
    const relay = new LocalRelay();
    const url = await relay.start();
    const signer = createMockSigner();
    const when = 1_700_000_100;
    const { app, store, close } = createApp({ dataDir: dir, now: () => unixSeconds(when) });
    const api = await authed(app);
    const created = await api.send("POST", "/api/profiles", bodyOf(signer, url));
    const saved = (await created.json()) as { id: string };
    const quiet = await api.send("POST", "/api/profiles", { ...bodyOf(createMockSigner(), url), label: "Quiet" });
    const quietBody = (await quiet.json()) as { id: string };
    const profile = loadProfiles(join(dir, "profiles.yaml"), { NOSTR_SCHEDULER_MODE: "test" }).find((item) => item.id === saved.id);
    if (!profile) throw new Error("missing profile");
    const suggested = store.suggest({
      profile,
      suggesterId: profile.suggesterId,
      draft: { type: "note", content: "still a suggestion", proposedFireAt: unixSeconds(when + 30) },
      rationale: "because",
      at: unixSeconds(when),
    });
    const approved = store.suggest({
      profile,
      suggesterId: profile.suggesterId,
      draft: { type: "note", content: "signed note", proposedFireAt: unixSeconds(when + 40) },
      rationale: "because",
      at: unixSeconds(when),
    });
    store.transition(approved.id, { type: "approve" }, unixSeconds(when));
    const ready = store.get(approved.id);
    if (ready.status !== "approved") throw new Error("not approved");
    const signed = await signer.signEvent({
      kind: 1,
      pubkey: signer.pubkey,
      created_at: unixSeconds(when + 40),
      tags: [],
      content: "signed note",
    });
    store.transition(approved.id, { type: "sign", events: [signed] }, unixSeconds(when));
    const queued = store.suggest({
      profile,
      suggesterId: profile.suggesterId,
      draft: { type: "note", content: "queued note", proposedFireAt: unixSeconds(when + 50) },
      rationale: "because",
      at: unixSeconds(when),
    });
    store.transition(queued.id, { type: "approve" }, unixSeconds(when));
    const queuedReady = store.get(queued.id);
    if (queuedReady.status !== "approved") throw new Error("not approved");
    const queuedSigned = await signer.signEvent({
      kind: 1,
      pubkey: signer.pubkey,
      created_at: unixSeconds(when + 50),
      tags: [],
      content: "queued note",
    });
    store.transition(queued.id, { type: "sign", events: [queuedSigned] }, unixSeconds(when));
    store.transition(queued.id, { type: "enqueue" }, unixSeconds(when));
    const removed = await api.send("DELETE", `/api/profiles/${saved.id}`);
    const removedBody = (await removed.json()) as { discarded: number };
    expect(removed.status).toBe(200);
    expect(removedBody.discarded).toBe(2);
    expect(store.get(suggested.id).status).toBe("suggestion");
    expect(store.get(approved.id).status).toBe("discarded");
    expect(store.get(queued.id).status).toBe("discarded");
    const seen = await fetchFromRelay(url, { authors: [signer.pubkey], kinds: [1] });
    expect(seen).toEqual([]);
    const empty = await api.send("DELETE", `/api/profiles/${quietBody.id}`);
    expect(await empty.json()).toMatchObject({ removed: true, discarded: 0 });
    close();
    await relay.stop();
  });

  test("masks a bunker link and does not treat its relay as a publish relay", async () => {
    const dir = tempDir();
    criteria(dir);
    watchConsole();
    const remote = "ab".repeat(32);
    const secret = "pairing-secret-value";
    const bunkerUri = `bunker://${remote}?relay=${encodeURIComponent("wss://relay.example")}&secret=${secret}`;
    const { app, close } = createApp({ dataDir: dir });
    const api = await authed(app);
    const created = await api.send("POST", "/api/profiles", {
      ...bodyOf(),
      signer: { kind: "nip46", bunkerUri },
    });
    const text = await created.text();
    expect(created.status, text).toBe(201);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("relay.example");
    expect(text).toContain("bunker://abababab…abab");
    const file = readFileSync(join(dir, "profiles.yaml"), "utf8");
    expect(file).toContain(secret);
    expect(logs.join("\n")).not.toContain(secret);
    const loaded = loadProfiles(join(dir, "profiles.yaml"), { NOSTR_SCHEDULER_MODE: "test" })[0];
    expect(loaded?.relays.configured.some((url) => url.includes("relay.example"))).toBe(false);
    expect(loaded?.relays.readNip65).toBe(false);
    expect(npubFromPubkey(loaded!.pubkey)).toBe(loaded?.npub);
    close();
  });
});
