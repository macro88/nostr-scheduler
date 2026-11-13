import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { appendFeedback, feedbackPath, readFeedback } from "../src/criteria/feedback.ts";
import { parseCriteria } from "../src/criteria/parse.ts";
import { eventId, relayUrl, suggestionId, suggesterId, unixSeconds } from "../src/domain/brand.ts";
import { nextThreadUnsigned, threadPlanFromDraft } from "../src/domain/event.ts";
import { InputError } from "../src/domain/brand.ts";
import { createMockSigner, startMockBunker } from "../src/mock-signer/index.ts";
import { callTool, handleRpc, mcpToolNames } from "../src/mcp/server.ts";
import { MCP_TOOL_NAMES } from "../src/domain/types.ts";
import { loadProfiles } from "../src/profiles/load.ts";
import { publishDue, virtualClock } from "../src/publisher/publish.ts";
import { signApproved } from "../src/signers/batch.ts";
import { connectBunker, connectParams, createNip46Signer } from "../src/signers/nip46.ts";
import { memorySessionStore } from "../src/signers/session-store.ts";
import { nip44SelfCheck } from "../src/signers/nip46-session.ts";
import { openNip07 } from "../src/signers/nip07.ts";
import { createNip55Signer } from "../src/signers/nip55.ts";
import { LocalRelay } from "../src/test-relay/relay.ts";
import { fetchFromRelay } from "../src/test-relay/client.ts";
import type { Approved, PerRelayResult, Profile, RelayUrl, SignedEvent } from "../src/domain/types.ts";
import { noteUnsigned } from "../src/domain/event.ts";
import { WorkStore } from "../src/work/store.ts";
import { runHarness } from "../src/demo/harness.ts";
import { runLocalDemo } from "../src/demo/local.ts";

const now = unixSeconds(1_700_000_000);
const example = readFileSync(new URL("../examples/criteria/example-profile.md", import.meta.url), "utf8");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sched-"));
}

function writeProfile(dir: string, signer: ReturnType<typeof createMockSigner>, kind: "mock" | "nip55" = "mock"): Profile {
  const criteria = join(dir, "criteria.md");
  writeFileSync(criteria, example);
  const relay = "ws://127.0.0.1:9";
  const yaml = [
    "profiles:",
    "  - id: example",
    "    label: Example",
    `    npub: ${signer.npub}`,
    `    pubkey: ${signer.pubkey}`,
    "    suggester_id: example-suggester",
    "    signer:",
    `      kind: ${kind}`,
    "    relays:",
    `      - ${relay}`,
    "    read_nip65: false",
    "    criteria_path: criteria.md",
    "",
  ].join("\n");
  const path = join(dir, "profiles.yaml");
  writeFileSync(path, yaml);
  const profiles = loadProfiles(path, { NOSTR_SCHEDULER_MODE: "test" });
  const profile = profiles[0];
  if (!profile) throw new Error("missing profile");
  return profile;
}

describe("criteria", () => {
  test("parses the example and names the field on failure", () => {
    const criteria = parseCriteria(example);
    expect(criteria.profileId).toBe("example");
    expect(criteria.cadence.timezone).toBe("Asia/Hong_Kong");
    expect(criteria.postTypes).toEqual(["note", "thread", "reply"]);
    expect(criteria.goodExamples.length).toBeGreaterThan(0);
    expect(() => parseCriteria(example.replace("timezone: Asia/Hong_Kong", "timezone: Not/AZone"))).toThrow(/timezone/);
    expect(() => parseCriteria(example.replace("post_types: [note, thread, reply]", "post_types: []"))).toThrow(/post_types/);
    try {
      parseCriteria(example.replace("posts_per_day: 1", "posts_per_day: -1"));
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      expect((error as InputError).field).toBe("posts_per_day");
    }
  });

  test("appends feedback without rewriting the brief or older entries", () => {
    const dir = tempDir();
    const criteriaPath = join(dir, "example.md");
    writeFileSync(criteriaPath, example);
    const path = feedbackPath(criteriaPath, "example");
    const first = {
      at: now,
      suggestionId: suggestionId("sug_01"),
      action: "rejected" as const,
      note: "Too close to a no-go topic.",
      criteriaVersion: parseCriteria(example).version,
    };
    appendFeedback(path, first);
    const before = readFileSync(criteriaPath, "utf8");
    appendFeedback(path, { ...first, suggestionId: suggestionId("sug_02"), action: "approved", note: "" });
    expect(readFileSync(criteriaPath, "utf8")).toBe(before);
    const entries = readFeedback(path);
    expect(entries[0]).toEqual(first);
    expect(entries).toHaveLength(2);
  });
});

describe("profiles", () => {
  test("rejects a mock signer in production and a mismatched npub", () => {
    const dir = tempDir();
    const signer = createMockSigner();
    writeProfile(dir, signer);
    expect(() => loadProfiles(join(dir, "profiles.yaml"), { NOSTR_SCHEDULER_MODE: "production" })).toThrow(/mock/);
    const broken = readFileSync(join(dir, "profiles.yaml"), "utf8").replace(signer.npub, createMockSigner().npub);
    writeFileSync(join(dir, "profiles.yaml"), broken);
    expect(() => loadProfiles(join(dir, "profiles.yaml"), { NOSTR_SCHEDULER_MODE: "test" })).toThrow(/npub/);
  });
});

describe("inbox and signing", () => {
  test("approves, rejects, and builds a thread root first", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    const profile = writeProfile(dir, signer);
    const store = new WorkStore(join(dir, "app.sqlite"));
    const note = store.suggest({
      profile,
      suggesterId: profile.suggesterId,
      draft: { type: "note", content: "one clear claim", proposedFireAt: unixSeconds(now + 30) },
      rationale: "on brief",
      at: now,
    });
    if (note.draft.type !== "note") throw new Error("expected a note");
    store.transition(note.id, { type: "edit", draft: { ...note.draft, content: "one clearer claim" } }, now, profile);
    const approved = store.transition(note.id, { type: "approve" }, now, profile);
    expect(approved.status).toBe("approved");
    const rejected = store.suggest({
      profile,
      suggesterId: suggesterId("example-suggester"),
      draft: { type: "note", content: "invest now", proposedFireAt: unixSeconds(now + 40) },
      rationale: "off brief",
      at: now,
    });
    expect(store.transition(rejected.id, { type: "reject", reason: "no-go topic" }, now, profile).status).toBe("rejected");
    expect(store.get(rejected.id).status).toBe("rejected");
    expect(store.list().some((item) => item.status === "rejected")).toBe(true);
    const feedback = readFeedback(feedbackPath(profile.criteriaPath, profile.id));
    expect(feedback.map((entry) => entry.action)).toEqual(["edited", "approved", "rejected"]);
    if (approved.status !== "approved") return;
    const relay = profile.relays.configured[0];
    if (!relay) throw new Error("fixture relay");
    const signed = await signApproved({
      signer,
      item: approved,
      now,
      maxAheadSeconds: 7 * 24 * 60 * 60,
      relayHint: profile.relays.configured[0],
    });
    expect(signed.events).toHaveLength(1);
    expect(signed.events[0]?.created_at).toBe(unixSeconds(now + 30));
    const thread = threadPlanFromDraft({
      pubkey: signer.pubkey,
      relayHint: relay,
      draft: {
        type: "thread",
        segments: [
          { content: "root", proposedFireAt: unixSeconds(now + 10) },
          { content: "reply", proposedFireAt: unixSeconds(now + 11) },
        ],
      },
    });
    const root = await signer.signEvent(thread.root);
    const reply = nextThreadUnsigned({ plan: thread, signedSoFar: [root] });
    expect(reply.tags).toEqual([
      ["e", root.id, profile.relays.configured[0], "root"],
      ["e", root.id, profile.relays.configured[0], "reply"],
      ["p", signer.pubkey, profile.relays.configured[0]],
    ]);
    expect(() =>
      threadPlanFromDraft({
        pubkey: signer.pubkey,
        relayHint: relay,
        draft: { type: "thread", segments: [{ content: "only", proposedFireAt: now }, { content: "same", proposedFireAt: now }] },
      }),
    ).toThrow(/increase/);
    store.close();
  });

  test("refuses the horizon, a desktop NIP-55 session, and a mismatched bunker result", async () => {
    const signer = createMockSigner();
    const profile = writeProfile(tempDir(), signer);
    const item: Approved = {
      status: "approved",
      id: suggestionId("sug_horizon1"),
      profileId: profile.id,
      suggesterId: profile.suggesterId,
      createdAt: now,
      approvedAt: now,
      draft: { type: "note", content: "later", proposedFireAt: unixSeconds(now + 8 * 24 * 60 * 60) },
    };
    await expect(
      signApproved({ signer, item, now, maxAheadSeconds: 7 * 24 * 60 * 60, relayHint: profile.relays.configured[0] }),
    ).rejects.toThrow(/horizon/);
    const past: Approved = { ...item, draft: { type: "note", content: "old", proposedFireAt: unixSeconds(now - 1) } };
    await expect(
      signApproved({ signer, item: past, now, maxAheadSeconds: 7 * 24 * 60 * 60, relayHint: profile.relays.configured[0] }),
    ).rejects.toThrow(/past/);
    await expect(createNip55Signer(signer.pubkey).signEvent(noteUnsigned({ pubkey: signer.pubkey, content: "x", createdAt: now }))).rejects.toThrow(/Android/);
    const adapter = createNip46Signer({
      userPubkey: signer.pubkey,
      call: async (_method, params) => {
        const unsigned = JSON.parse(params[0] ?? "{}") as { content: string };
        const signed = await signer.signEvent(noteUnsigned({ pubkey: signer.pubkey, content: "changed", createdAt: now }));
        expect(unsigned.content).toBe("hello");
        return JSON.stringify(signed);
      },
    });
    await expect(adapter.signEvent(noteUnsigned({ pubkey: signer.pubkey, content: "hello", createdAt: now }))).rejects.toThrow(/content/);
  });
});

describe("nip07", () => {
  test("binds loopback and accepts only a matching signed event", async () => {
    const signer = createMockSigner();
    const unsigned = noteUnsigned({ pubkey: signer.pubkey, content: "page", createdAt: now });
    const opened = await openNip07({ events: [unsigned], expectedPubkey: signer.pubkey, timeoutMs: 2000 });
    expect(opened.session.host).toBe("127.0.0.1");
    expect(opened.session.url.startsWith("http://127.0.0.1:")).toBe(true);
    expect(opened.session.page.includes(["ns", "ec"].join(""))).toBe(false);
    expect(opened.session.page).not.toMatch(/type="password"/);
    const page = await fetch(opened.session.url);
    expect(await page.text()).toContain("window.nostr");
    const pending = await fetch(new URL("/pending", opened.session.url));
    expect((await pending.json()).event.content).toBe("page");
    const signed = await signer.signEvent(unsigned);
    const post = await fetch(new URL("/signed", opened.session.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signed),
    });
    expect(post.status).toBe(204);
    await expect(opened.signed).resolves.toMatchObject([{ id: signed.id }]);
    await opened.session.close();
  });
});

describe("nip46", () => {
  test("matches the published payload vector and a local bunker", async () => {
    nip44SelfCheck();
    const relay = new LocalRelay();
    const url = await relay.start();
    const bunker = await startMockBunker(url);
    try {
      const signer = await connectBunker({
        bunkerUri: bunker.uri,
        userPubkey: bunker.pubkey,
        sessionDir: join(tempDir(), "nip46"),
        now: () => now,
        session: { store: memorySessionStore(), keychain: () => null },
      });
      const unsigned = noteUnsigned({ pubkey: bunker.pubkey, content: "remote", createdAt: unixSeconds(now + 5) });
      const signed = await signer.signEvent(unsigned);
      expect(signed.content).toBe("remote");
      expect(signed.pubkey).toBe(bunker.pubkey);
      expect(bunker.permissions).toEqual(["sign_event:1"]);
      expect(connectParams("token").join(" ")).not.toMatch(/encrypt|decrypt/);
    } finally {
      bunker.close();
      await relay.stop();
    }
  });
});

describe("publisher", () => {
  test("holds the future, sends inside the window, misses after it, and retries", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    const profile = writeProfile(dir, signer);
    const store = new WorkStore(join(dir, "app.sqlite"));
    const relay = relayUrl("ws://127.0.0.1:1");
    const calls: string[] = [];
    let fail = 1;
    const transport = {
      async publish(target: RelayUrl, event: SignedEvent): Promise<PerRelayResult> {
        calls.push(event.content);
        if (fail > 0) {
          fail -= 1;
          return { relay: target, accepted: false, message: "rejected" };
        }
        return { relay: target, accepted: true, message: "" };
      },
    };
    const clock = virtualClock(now);
    async function queue(content: string, at: number) {
      const suggested = store.suggest({
        profile,
        suggesterId: profile.suggesterId,
        draft: { type: "note", content, proposedFireAt: unixSeconds(at) },
        rationale: content,
        at: now,
      });
      store.transition(suggested.id, { type: "approve" }, now, profile);
      const item = store.get(suggested.id);
      if (item.status !== "approved") throw new Error("expected approved");
      const signed = await signApproved({
        signer,
        item,
        now,
        maxAheadSeconds: 7 * 24 * 60 * 60,
        relayHint: relay,
      });
      store.transition(suggested.id, { type: "sign", events: [...signed.events] }, now);
      store.transition(suggested.id, { type: "enqueue" }, now);
      return suggested.id;
    }
    const future = await queue("future", now + 3600);
    const due = await queue("due", now + 10);
    const late = await queue("late", now + 20);
    await publishDue({
      store,
      profiles: [profile],
      transport,
      now: () => clock.now(),
      windowSeconds: 900,
      sleep: async (seconds) => clock.advance(seconds),
      delays: [5],
    });
    expect(calls).toEqual([]);
    expect(store.get(future).status).toBe("queued");
    clock.advance(10);
    await publishDue({
      store,
      profiles: [profile],
      transport,
      now: () => clock.now(),
      windowSeconds: 900,
      sleep: async (seconds) => clock.advance(seconds),
      delays: [5],
    });
    expect(store.get(due).status).toBe("sent");
    expect(store.get(future).status).toBe("queued");
    clock.advance(20 - 10 + 901);
    await publishDue({
      store,
      profiles: [profile],
      transport,
      now: () => clock.now(),
      windowSeconds: 900,
      sleep: async () => undefined,
      delays: [],
    });
    expect(store.get(late).status).toBe("missed");
    expect(calls.filter((content) => content === "late")).toEqual([]);
    const discarded = await queue("drop", now + 8000);
    store.transition(discarded, { type: "discard", reason: "no" }, clock.now());
    const before = calls.length;
    await publishDue({
      store,
      profiles: [profile],
      transport,
      now: () => unixSeconds(now + 8000),
      windowSeconds: 900,
      sleep: async () => undefined,
      delays: [],
    });
    expect(calls.length).toBe(before);
    expect(store.get(discarded).status).toBe("discarded");
    store.close();
  });

  test("one accepting relay marks sent and a thread goes root first", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    writeProfile(dir, signer);
    const second = relayUrl("ws://127.0.0.1:2");
    const yaml = readFileSync(join(dir, "profiles.yaml"), "utf8").replace(
      "      - ws://127.0.0.1:9",
      "      - ws://127.0.0.1:9\n      - ws://127.0.0.1:2",
    );
    writeFileSync(join(dir, "profiles.yaml"), yaml);
    const loaded = loadProfiles(join(dir, "profiles.yaml"), { NOSTR_SCHEDULER_MODE: "test" })[0];
    if (!loaded) throw new Error("missing profile");
    const store = new WorkStore(join(dir, "app.sqlite"));
    const order: string[] = [];
    const transport = {
      async publish(target: RelayUrl, event: SignedEvent): Promise<PerRelayResult> {
        order.push(`${target} ${event.content}`);
        return { relay: target, accepted: target === second, message: target === second ? "" : "no" };
      },
    };
    const suggested = store.suggest({
      profile: loaded,
      suggesterId: loaded.suggesterId,
      draft: {
        type: "thread",
        segments: [
          { content: "root", proposedFireAt: unixSeconds(now + 1) },
          { content: "next", proposedFireAt: unixSeconds(now + 2) },
        ],
      },
      rationale: "thread",
      at: now,
    });
    store.transition(suggested.id, { type: "approve" }, now, loaded);
    const item = store.get(suggested.id);
    if (item.status !== "approved") throw new Error("expected approved");
    const signed = await signApproved({
      signer,
      item,
      now,
      maxAheadSeconds: 7 * 24 * 60 * 60,
      relayHint: loaded.relays.configured[0],
    });
    expect(signed.events[0]?.content).toBe("root");
    expect(signed.events[1]?.tags.some((tag) => tag[3] === "root")).toBe(true);
    store.transition(suggested.id, { type: "sign", events: [...signed.events] }, now);
    store.transition(suggested.id, { type: "enqueue" }, now);
    const clock = virtualClock(now + 1);
    await publishDue({
      store,
      profiles: [loaded],
      transport,
      now: () => clock.now(),
      windowSeconds: 900,
      sleep: async () => undefined,
      delays: [],
    });
    expect(store.get(suggested.id).status).toBe("queued");
    clock.advance(1);
    await publishDue({
      store,
      profiles: [loaded],
      transport,
      now: () => clock.now(),
      windowSeconds: 900,
      sleep: async () => undefined,
      delays: [],
    });
    expect(store.get(suggested.id).status).toBe("sent");
    expect(order.map((line) => line.split(" ")[1])).toEqual(["root", "root", "next", "next"]);
    store.close();
  });
});

describe("mcp", () => {
  test("exposes only the five tools and can suggest without publishing", async () => {
    expect(mcpToolNames()).toEqual([...MCP_TOOL_NAMES]);
    expect(mcpToolNames().some((name) => name.includes("sign") || name.includes("publish"))).toBe(false);
    const dir = tempDir();
    const signer = createMockSigner();
    const profile = writeProfile(dir, signer);
    const store = new WorkStore(join(dir, "app.sqlite"));
    const before = readFileSync(join(dir, "app.sqlite"));
    const ctx = { profiles: [profile], store, now: () => now };
    const listed = await handleRpc(ctx, { method: "tools/list", id: 1 });
    expect(JSON.stringify(listed)).toContain("list_profiles");
    expect(JSON.stringify(listed)).not.toContain("sign_event");
    const suggestion = await callTool(ctx, "suggest_post", {
      profileId: "example",
      suggesterId: "example-suggester",
      rationale: "because",
      draft: { type: "note", content: "from the tool", proposedFireAt: now + 15 },
    });
    expect(suggestion).toMatchObject({ status: "suggestion" });
    const queue = await callTool(ctx, "list_queue", { profileId: "example" });
    const afterQueue = readFileSync(join(dir, "app.sqlite"));
    await callTool(ctx, "list_queue", {});
    expect(readFileSync(join(dir, "app.sqlite")).equals(afterQueue)).toBe(true);
    expect(queue).toMatchObject([{ status: "suggestion" }]);
    await expect(callTool(ctx, "sign_event", {})).rejects.toThrow(/unknown tool/);
    expect(before.equals(afterQueue)).toBe(false);
    const relay = new LocalRelay();
    const url = await relay.start();
    const target = await signer.signEvent(noteUnsigned({ pubkey: signer.pubkey, content: "target", createdAt: now }));
    const { publishToRelay } = await import("../src/test-relay/client.ts");
    await publishToRelay(url, target);
    const yaml = readFileSync(join(dir, "profiles.yaml"), "utf8").replace("ws://127.0.0.1:9", url);
    writeFileSync(join(dir, "profiles.yaml"), yaml);
    const live = loadProfiles(join(dir, "profiles.yaml"), { NOSTR_SCHEDULER_MODE: "test" });
    const context = await callTool(
      { profiles: live, store, now: () => now },
      "get_thread_context",
      { profileId: "example", eventId: target.id, pubkey: signer.pubkey, rootId: target.id },
    );
    expect(context).toMatchObject({ context: expect.stringContaining("target") });
    await expect(
      callTool(
        { profiles: live, store, now: () => now },
        "get_thread_context",
        { profileId: "example", eventId: eventId("ab".repeat(32)), pubkey: signer.pubkey, rootId: eventId("ab".repeat(32)) },
      ),
    ).rejects.toThrow(/no event/);
    const seen = await fetchFromRelay(url, { ids: [target.id] });
    expect(seen).toHaveLength(1);
    store.close();
    await relay.stop();
  });
});

describe("demos", () => {
  test("harness and local demo stay on loopback", async () => {
    const harness = await runHarness();
    expect(harness.relay.startsWith("ws://127.0.0.1:")).toBe(true);
    const dir = tempDir();
    const first = await runLocalDemo(dir);
    const second = await runLocalDemo(dir);
    expect(first.sentOnRelay).toBe(true);
    expect(first.futureOnRelay).toBe(false);
    expect(first.missedOnRelay).toBe(false);
    expect(second.sentOnRelay).toBe(true);
    expect(second.sentId).not.toBe(first.sentId);
  });
});

describe("frozen events", () => {
  test("the queue refuses a changed payload", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    const profile = writeProfile(dir, signer);
    const store = new WorkStore(join(dir, "app.sqlite"));
    const suggested = store.suggest({
      profile,
      suggesterId: profile.suggesterId,
      draft: { type: "note", content: "frozen", proposedFireAt: unixSeconds(now + 5) },
      rationale: "x",
      at: now,
    });
    store.transition(suggested.id, { type: "approve" }, now, profile);
    const item = store.get(suggested.id);
    if (item.status !== "approved") throw new Error("expected approved");
    const signed = await signApproved({
      signer,
      item,
      now,
      maxAheadSeconds: 100,
      relayHint: profile.relays.configured[0],
    });
    store.transition(suggested.id, { type: "sign", events: [...signed.events] }, now);
    const changed = { ...signed.events[0], content: "nope" } as SignedEvent;
    expect(() => store.transition(suggested.id, { type: "enqueue" }, now)).not.toThrow();
    const queued = store.get(suggested.id);
    expect(queued.status).toBe("queued");
    expect(() => store.transition(suggested.id, { type: "sign", events: [changed] }, now)).toThrow(/cannot sign/);
    store.close();
  });
});
