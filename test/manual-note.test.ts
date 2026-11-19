import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { feedbackPath } from "../src/criteria/feedback.ts";
import { relayUrl, unixSeconds } from "../src/domain/brand.ts";
import { noteUnsigned } from "../src/domain/event.ts";
import { createApp } from "../src/http/app.ts";
import { callTool } from "../src/mcp/server.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { loadProfiles } from "../src/profiles/load.ts";
import { WorkStore } from "../src/work/store.ts";
import { statusWord } from "../web/src/labels.ts";

const example = readFileSync(new URL("../examples/criteria/example-profile.md", import.meta.url), "utf8");
const fixture = "nsec1notarealkeyxxxxxxxx";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sched-manual-"));
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
    patch: (path: string, payload: unknown) =>
      app.request(`http://127.0.0.1:4173${path}`, { method: "PATCH", headers, body: JSON.stringify(payload) }),
    get: (path: string) => app.request(`http://127.0.0.1:4173${path}`, { headers: { host: headers.host, cookie } }),
  };
}

describe("manual notes and suggestions", () => {
  test("a note you write does not need criteria, and a suggester cannot claim it", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    const clock = 1_700_000_000;
    const { app, store, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    const api = await authed(app);
    const created = await api.post("/api/profiles", {
      label: "Desk",
      npub: signer.npub,
      signer: { kind: "nip07" },
      relays: ["ws://127.0.0.1:9"],
    });
    const profile = (await created.json()) as {
      id?: string;
      criteriaPath?: string | null;
      criteriaExists?: boolean;
      allowPublicRelays?: boolean;
      readNip65?: boolean;
    };
    expect(created.status).toBe(201);
    expect(profile.id).toBe("desk");
    expect(profile.criteriaPath).toBeNull();
    expect(profile.criteriaExists).toBe(false);
    expect(profile.allowPublicRelays).toBe(false);
    expect(profile.readNip65).toBe(false);
    const yaml = readFileSync(join(dir, "profiles.yaml"), "utf8");
    expect(yaml).not.toContain("criteria_path");
    expect(yaml).not.toContain("profile_id:");
    expect(readdirSync(dir).some((name) => name.endsWith(".md"))).toBe(false);

    const draft = { type: "note", content: "Written here.", proposedFireAt: clock + 3600 };
    const saved = await api.post("/api/compose", {
      profileId: "desk",
      draft,
      origin: "suggestion",
      writtenBy: "agent",
    });
    const note = (await saved.json()) as { id?: string; origin?: string; status?: string; fireAt?: number[] };
    expect(saved.status).toBe(200);
    expect(note.origin).toBe("manual");
    expect(note.status).toBe("approved");
    expect(note.fireAt).toEqual([clock + 3600]);
    expect(existsSync(join(dir, "criteria"))).toBe(false);

    const blocked = await api.post("/api/suggestions", {
      profileId: "desk",
      rationale: "the agent wrote this",
      draft: { type: "note", content: "Suggested.", proposedFireAt: clock + 3600 },
      origin: "manual",
      writtenBy: "human",
    });
    const blockedBody = (await blocked.json()) as { error?: string };
    expect(blocked.status).toBe(400);
    expect(blockedBody.error).toContain("no criteria for suggestions");
    const items = (await (await api.get("/api/items?profileId=desk")).json()) as { origin: string; preview: string }[];
    expect(items.map((item) => item.origin)).toEqual(["manual"]);
    expect(items.some((item) => item.preview.includes("Suggested"))).toBe(false);

    const profiles = loadProfiles(join(dir, "profiles.yaml"));
    const owner = profiles[0];
    if (!owner) throw new Error("missing profile");
    await expect(
      callTool({ profiles, store, now: () => unixSeconds(clock) }, "suggest_post", {
        profileId: "desk",
        suggesterId: owner.suggesterId,
        draft,
        rationale: "claim this as human",
        origin: "manual",
        writtenBy: "human",
      }),
    ).rejects.toThrow(/no criteria/);

    const edited = await api.post(`/api/items/${note.id}/edit`, {
      draft: { type: "note", content: "Written here, still.", proposedFireAt: clock + 3600 },
    });
    const editedBody = (await edited.json()) as { origin?: string; preview?: string; fireAt?: number[] };
    expect(edited.status).toBe(200);
    expect(editedBody.origin).toBe("manual");
    expect(editedBody.preview).toContain("Written here, still.");
    expect(editedBody.fireAt).toEqual([clock + 3600]);

    const secret = await api.post("/api/compose", {
      profileId: "desk",
      draft: { type: "note", content: `keep ${fixture} out of the note`, proposedFireAt: clock + 3600 },
    });
    expect(secret.status).toBe(400);
    close();

    const later = new WorkStore(join(dir, "app.sqlite"));
    const current = later.list(owner.id).find((item) => item.origin === "manual" && item.status === "approved");
    if (!current || current.status !== "approved" || current.draft.type !== "note") throw new Error("expected the manual note");
    const signed = await signer.signEvent(
      noteUnsigned({ pubkey: signer.pubkey, content: current.draft.content, createdAt: current.draft.proposedFireAt }),
    );
    later.transition(current.id, { type: "sign", events: [signed] }, unixSeconds(clock));
    later.transition(current.id, { type: "enqueue" }, unixSeconds(clock));
    const missed = later.transition(current.id, { type: "missed", lateBySeconds: 5 }, unixSeconds(clock + 7200), owner);
    expect(missed.status).toBe("missed");
    expect(missed.origin).toBe("manual");
    expect(readdirSync(dir).join(" ")).not.toContain("feedback");
    later.close();
  });

  test("a real criteria file still gates suggestions and ignores a manual claim", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    const clock = 1_700_000_000;
    const { app, store, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    const api = await authed(app);
    const missing = await api.post("/api/profiles", {
      label: "Desk",
      npub: signer.npub,
      signer: { kind: "nip07" },
      relays: ["ws://127.0.0.1:9"],
      criteriaPath: "criteria/missing.md",
    });
    expect(missing.status).toBe(400);
    expect(existsSync(join(dir, "profiles.yaml"))).toBe(false);

    mkdirSync(join(dir, "criteria"), { recursive: true });
    writeFileSync(join(dir, "criteria", "demo.md"), example.replace("profile_id: example", "profile_id: desk"));
    const created = await api.post("/api/profiles", {
      label: "Desk",
      npub: signer.npub,
      signer: { kind: "nip07" },
      relays: ["ws://127.0.0.1:9"],
      criteriaPath: "criteria/demo.md",
    });
    expect(created.status).toBe(201);
    const draft = { type: "note", content: "From the suggester.", proposedFireAt: clock + 3600 };
    const suggested = await api.post("/api/suggestions", {
      profileId: "desk",
      rationale: "because",
      draft,
      origin: "manual",
      writtenBy: "human",
    });
    const suggestion = (await suggested.json()) as { id: string; origin: string; status: string };
    expect(suggested.status).toBe(200);
    expect(suggestion.origin).toBe("suggestion");
    expect(suggestion.status).toBe("suggestion");
    const profiles = loadProfiles(join(dir, "profiles.yaml"));
    const owner = profiles[0];
    if (!owner) throw new Error("missing profile");
    const viaMcp = (await callTool({ profiles, store, now: () => unixSeconds(clock) }, "suggest_post", {
      profileId: "desk",
      suggesterId: owner.suggesterId,
      draft: { type: "note", content: "Also from the suggester.", proposedFireAt: clock + 7200 },
      rationale: "because",
      origin: "manual",
      writtenBy: "human",
    })) as { origin?: string; status?: string };
    expect(viaMcp.origin).toBe("suggestion");
    expect(viaMcp.status).toBe("suggestion");

    rmSync(join(dir, "criteria", "demo.md"));
    const approved = await api.post(`/api/items/${suggestion.id}/approve`, {});
    expect(approved.status).toBe(400);
    const during = (await (await api.get("/api/items?profileId=desk")).json()) as { id: string; status: string; origin: string }[];
    expect(during.find((item) => item.id === suggestion.id)).toMatchObject({ status: "suggestion", origin: "suggestion" });
    expect(existsSync(feedbackPath(join(dir, "criteria", "demo.md"), "desk"))).toBe(false);
    close();
  });

  test("saving without scheduling keeps a manual draft and one later schedule", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    const clock = 1_700_000_000;
    const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    const api = await authed(app);
    await api.post("/api/profiles", {
      label: "Desk",
      npub: signer.npub,
      signer: { kind: "nip07" },
      relays: ["ws://127.0.0.1:9"],
    });
    const draft = { type: "note", content: "Hold this.", proposedFireAt: clock + 3600 };
    const saved = await api.post("/api/drafts", { profileId: "desk", draft, origin: "suggestion", writtenBy: "agent" });
    const body = (await saved.json()) as { id: string; status: string; origin: string };
    expect(saved.status).toBe(200);
    expect(body.status).toBe("draft");
    expect(body.origin).toBe("manual");
    const again = await api.post("/api/drafts", { profileId: "desk", id: body.id, draft: { ...draft, content: "Hold this, still." } });
    expect(again.status).toBe(200);
    const scheduled = await api.post(`/api/items/${body.id}/approve`, {});
    const scheduledBody = (await scheduled.json()) as { status: string; origin: string };
    expect(scheduled.status).toBe(200);
    expect(scheduledBody).toMatchObject({ status: "approved", origin: "manual" });
    const items = (await (await api.get("/api/items?profileId=desk")).json()) as { id: string; status: string }[];
    expect(items.map((item) => ({ id: item.id, status: item.status }))).toEqual([{ id: body.id, status: "approved" }]);
    expect(existsSync(join(dir, "criteria"))).toBe(false);
    const suggestion = await api.post("/api/suggestions", {
      profileId: "desk",
      rationale: "agent",
      draft,
      origin: "manual",
    });
    expect(suggestion.status).toBe(400);
    close();
  });

  test("an unusable criteria path blocks manual scheduling and a repair allows it", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    const clock = 1_700_000_000;
    const custom = ["---", "profile_id: other", "version: 4", "---", "# Voice", "keep this voice", "", "## Bench notes", "do not rewrite", ""].join("\n");
    mkdirSync(join(dir, "criteria"), { recursive: true });
    writeFileSync(join(dir, "criteria", "kept.md"), custom);
    writeFileSync(
      join(dir, "profiles.yaml"),
      [
        "profiles:",
        "  - id: test",
        "    label: Test",
        `    npub: ${signer.npub}`,
        `    pubkey: ${signer.pubkey}`,
        "    suggester_id: test-suggester",
        "    signer:",
        "      kind: nip07",
        "    relays:",
        "      - ws://127.0.0.1:9",
        "    read_nip65: false",
        "    allow_public_relays: false",
        "    criteria_path: test",
        "",
      ].join("\n"),
    );
    const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    const api = await authed(app);
    const draft = { type: "note", content: "Held for repair.", proposedFireAt: clock + 3600 };
    const composed = await api.post("/api/compose", { profileId: "test", draft });
    const composedBody = (await composed.json()) as { error?: string };
    expect(composed.status).toBe(400);
    expect(composedBody.error).toContain("test");
    const saved = await api.post("/api/drafts", { profileId: "test", draft });
    const draftBody = (await saved.json()) as { id: string; status: string; origin: string };
    expect(saved.status).toBe(200);
    expect(draftBody).toMatchObject({ status: "draft", origin: "manual" });
    const blocked = await api.post(`/api/items/${draftBody.id}/approve`, {});
    expect(blocked.status).toBe(400);
    const during = (await (await api.get("/api/items?profileId=test")).json()) as { id: string; status: string; origin: string }[];
    expect(during.map((item) => ({ id: item.id, status: item.status, origin: item.origin }))).toEqual([
      { id: draftBody.id, status: "draft", origin: "manual" },
    ]);
    expect(existsSync(join(dir, "test.feedback.yaml"))).toBe(false);
    expect(readFileSync(join(dir, "criteria", "kept.md"), "utf8")).toBe(custom);
    const suggested = await api.post("/api/suggestions", { profileId: "test", rationale: "agent", draft });
    expect(suggested.status).toBe(400);
    expect((await (await api.get("/api/items?profileId=test")).json()) as { status: string }[]).toHaveLength(1);

    const repaired = await api.patch("/api/profiles/test", {
      label: "Test",
      npub: signer.npub,
      signer: { kind: "nip07" },
      relays: ["ws://127.0.0.1:9"],
      criteriaPath: "",
    });
    expect(repaired.status).toBe(200);
    const scheduled = await api.post(`/api/items/${draftBody.id}/approve`, {});
    const scheduledBody = (await scheduled.json()) as { status: string; origin: string };
    expect(scheduled.status).toBe(200);
    expect(scheduledBody).toMatchObject({ status: "approved", origin: "manual" });
    const open = await api.post("/api/compose", {
      profileId: "test",
      draft: { type: "note", content: "After repair.", proposedFireAt: clock + 7200 },
    });
    expect(open.status).toBe(200);
    const after = (await (await api.get("/api/items?profileId=test")).json()) as { status: string; origin: string; preview: string }[];
    expect(after.map((item) => item.status).sort()).toEqual(["approved", "approved"]);
    expect(after.every((item) => item.origin === "manual")).toBe(true);
    expect(readFileSync(join(dir, "criteria", "kept.md"), "utf8")).toBe(custom);
    const still = await api.post("/api/suggestions", { profileId: "test", rationale: "agent", draft });
    expect(still.status).toBe(400);
    close();
  });

  test("the same schedule id is stored once, and a different id keeps an identical note", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    const clock = 1_700_000_000;
    const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    const api = await authed(app);
    const created = await api.post("/api/profiles", {
      label: "Desk",
      npub: signer.npub,
      signer: { kind: "nip07" },
      relays: ["ws://127.0.0.1:9"],
    });
    expect(created.status).toBe(201);
    const draft = { type: "note", content: "Same words.", proposedFireAt: clock + 3600 };
    const first = await api.post("/api/compose", { profileId: "desk", id: "sug_sameintent01", draft });
    const again = await api.post("/api/compose", { profileId: "desk", id: "sug_sameintent01", draft });
    const other = await api.post("/api/compose", { profileId: "desk", id: "sug_sameintent02", draft });
    const clash = await api.post("/api/compose", {
      profileId: "desk",
      id: "sug_sameintent01",
      draft: { type: "note", content: "Different words.", proposedFireAt: clock + 3600 },
    });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect((await again.json()) as { id: string }).toMatchObject({ id: "sug_sameintent01", status: "approved" });
    expect(other.status).toBe(200);
    expect(clash.status).toBe(400);
    const rows = (await (await api.get("/api/items?profileId=desk")).json()) as { id: string; preview: string }[];
    expect(rows.map((item) => item.id).sort()).toEqual(["sug_sameintent01", "sug_sameintent02"]);
    expect(rows.every((item) => item.preview === "Same words.")).toBe(true);
    close();
  });

  test("awaiting signature is the stored approved row, and queued or sent stay signed states", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    const clock = 1_700_000_000;
    const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    const api = await authed(app);
    expect((await api.post("/api/profiles", { label: "Desk", npub: signer.npub, signer: { kind: "nip07" }, relays: ["ws://127.0.0.1:9"] })).status).toBe(201);
    const draft = { type: "note", content: "Unsigned on purpose.", proposedFireAt: clock + 3600 };
    const created = await api.post("/api/compose", { profileId: "desk", draft });
    const view = (await created.json()) as { id: string; status: string; events?: unknown };
    expect(created.status).toBe(200);
    expect(view.status).toBe("approved");
    expect(view.events).toBeUndefined();
    expect(statusWord(view.status)).toBe("Awaiting signature");
    close();

    const store = new WorkStore(join(dir, "app.sqlite"));
    const raw = store.db.prepare("SELECT body_json FROM work_items WHERE id = ?").get(view.id) as { body_json: string };
    const stored = JSON.parse(raw.body_json) as { status: string; events?: unknown; sig?: unknown };
    expect(stored.status).toBe("approved");
    expect(stored.events).toBeUndefined();
    expect(stored.sig).toBeUndefined();
    expect(raw.body_json).not.toContain("\"sig\"");
    const approved = store.list().find((item) => item.id === view.id);
    if (!approved || approved.status !== "approved" || approved.draft.type !== "note") throw new Error("expected an unsigned approved note");
    expect("events" in approved).toBe(false);
    const signature = await signer.signEvent(noteUnsigned({ pubkey: signer.pubkey, content: approved.draft.content, createdAt: approved.draft.proposedFireAt }));
    const signed = store.transition(approved.id, { type: "sign", events: [signature] }, unixSeconds(clock));
    if (signed.status !== "signed") throw new Error("expected a signature");
    expect(signed.events).toHaveLength(1);
    expect(signed.events[0]?.sig).toBe(signature.sig);
    expect(statusWord(signed.status)).toBe("Signed");
    const queued = store.transition(signed.id, { type: "enqueue" }, unixSeconds(clock));
    if (queued.status !== "queued") throw new Error("expected the signed note to be queued");
    expect(queued.events[0]?.id).toBe(signature.id);
    expect(statusWord(queued.status)).toBe("Queued");
    const sent = store.transition(
      queued.id,
      { type: "sent", results: [{ relay: relayUrl("ws://127.0.0.1:9"), accepted: true, message: "accepted" }] },
      unixSeconds(clock),
    );
    if (sent.status !== "sent") throw new Error("expected the queued note to be sent");
    expect(sent.events[0]?.id).toBe(signature.id);
    expect(statusWord(sent.status)).toBe("Sent");
    expect(statusWord(sent.status)).not.toBe("Awaiting signature");
    store.close();
  });

  test("one schedule id is one row for a note, a thread, and a reply, and a changed payload is refused", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    const clock = 1_700_000_000;
    const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    const api = await authed(app);
    expect((await api.post("/api/profiles", { label: "Desk", npub: signer.npub, signer: { kind: "nip07" }, relays: ["ws://127.0.0.1:9"] })).status).toBe(201);
    const note = { type: "note", content: "Same words.", proposedFireAt: clock + 3600 };
    const thread = {
      type: "thread",
      segments: [
        { content: "Root line", proposedFireAt: clock + 3600 },
        { content: "Reply line", proposedFireAt: clock + 3601 },
      ],
    };
    const target = { eventId: "a".repeat(64), pubkey: "b".repeat(64), rootId: "c".repeat(64) };
    const reply = { type: "reply", content: "A reply.", proposedFireAt: clock + 3600, target };
    const [firstNote, racedNote] = await Promise.all([
      api.post("/api/compose", { profileId: "desk", id: "sug_noteintent01", draft: note }),
      api.post("/api/compose", { profileId: "desk", id: "sug_noteintent01", draft: note }),
    ]);
    expect(firstNote.status).toBe(200);
    expect(racedNote.status).toBe(200);
    expect(((await firstNote.json()) as { id: string }).id).toBe("sug_noteintent01");
    expect(((await racedNote.json()) as { id: string }).id).toBe("sug_noteintent01");
    const otherNote = await api.post("/api/compose", { profileId: "desk", id: "sug_noteintent02", draft: note });
    expect(otherNote.status).toBe(200);
    const threadOnce = await api.post("/api/compose", { profileId: "desk", id: "sug_threadintent", draft: thread });
    const threadAgain = await api.post("/api/compose", { profileId: "desk", id: "sug_threadintent", draft: thread });
    expect(threadOnce.status).toBe(200);
    expect(threadAgain.status).toBe(200);
    const replyOnce = await api.post("/api/compose", { profileId: "desk", id: "sug_replyintent1", draft: reply });
    const replyAgain = await api.post("/api/compose", { profileId: "desk", id: "sug_replyintent1", draft: reply });
    expect(replyOnce.status).toBe(200);
    expect(replyAgain.status).toBe(200);
    const clash = await api.post("/api/compose", {
      profileId: "desk",
      id: "sug_noteintent01",
      draft: { type: "note", content: "Different words.", proposedFireAt: clock + 3600 },
    });
    expect(clash.status).toBe(400);
    const saved = await api.post("/api/drafts", { profileId: "desk", draft: { type: "note", content: "Saved first.", proposedFireAt: clock + 7200 } });
    const savedBody = (await saved.json()) as { id: string; status: string };
    expect(saved.status).toBe(200);
    const edited = await api.post("/api/drafts", {
      profileId: "desk",
      id: savedBody.id,
      draft: { type: "note", content: "Saved first, edited.", proposedFireAt: clock + 7200 },
    });
    expect(((await edited.json()) as { id: string }).id).toBe(savedBody.id);
    const approved = await api.post(`/api/items/${savedBody.id}/approve`, {});
    const approvedAgain = await api.post(`/api/items/${savedBody.id}/approve`, {});
    expect(((await approved.json()) as { id: string; status: string }).id).toBe(savedBody.id);
    expect(approvedAgain.status).toBe(400);
    const rows = (await (await api.get("/api/items?profileId=desk")).json()) as { id: string; status: string; preview: string }[];
    expect(rows.filter((item) => item.id === "sug_noteintent01")).toHaveLength(1);
    expect(rows.filter((item) => item.preview === "Same words.")).toHaveLength(2);
    expect(rows.filter((item) => item.id === "sug_threadintent")).toHaveLength(1);
    expect(rows.filter((item) => item.id === "sug_replyintent1")).toHaveLength(1);
    expect(rows.filter((item) => item.id === savedBody.id && item.status === "approved" && item.preview === "Saved first, edited.")).toHaveLength(1);
    expect(rows.find((item) => item.id === "sug_noteintent01")?.preview).toBe("Same words.");
    close();
  });
});
