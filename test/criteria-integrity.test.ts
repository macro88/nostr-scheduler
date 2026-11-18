import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { armFeedbackWriteFailure, readFeedback, feedbackPath } from "../src/criteria/feedback.ts";
import { suggestionId, unixSeconds } from "../src/domain/brand.ts";
import { createApp } from "../src/http/app.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { loadProfiles } from "../src/profiles/load.ts";
import { publishDue } from "../src/publisher/publish.ts";
import { armFeedbackRestoreFailure } from "../src/work/store.ts";

const example = readFileSync(new URL("../examples/criteria/example-profile.md", import.meta.url), "utf8");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sched-criteria-"));
}

function writeCriteria(dir: string, name: string, profileId: string) {
  mkdirSync(join(dir, "criteria"), { recursive: true });
  writeFileSync(join(dir, "criteria", name), example.replace("profile_id: example", `profile_id: ${profileId}`));
}

function writeProfile(dir: string, signer: ReturnType<typeof createMockSigner>, criteriaName: string, id = "desk") {
  writeFileSync(
    join(dir, "profiles.yaml"),
    [
      "profiles:",
      `  - id: ${id}`,
      "    label: Desk",
      `    npub: ${signer.npub}`,
      `    pubkey: ${signer.pubkey}`,
      `    suggester_id: ${id}-suggester`,
      "    signer:",
      "      kind: nip07",
      "    relays:",
      "      - ws://127.0.0.1:9",
      "    read_nip65: false",
      "    allow_public_relays: false",
      `    criteria_path: criteria/${criteriaName}`,
      "",
    ].join("\n"),
  );
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

function profileBody(signer: ReturnType<typeof createMockSigner>, criteriaPath: string) {
  return {
    label: "Desk",
    npub: signer.npub,
    signer: { kind: "nip07" },
    criteriaPath,
    relays: ["ws://127.0.0.1:9"],
  };
}

describe("criteria identity and save integrity", () => {
  test("a missing or mismatched criteria file blocks profile setup and names the file", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    const { app, close } = createApp({ dataDir: dir });
    const api = await authed(app);
    const missing = await api.post("/api/profiles", profileBody(signer, "criteria/missing.md"));
    const missingBody = (await missing.json()) as { error?: string };
    expect(missing.status).toBe(400);
    expect(missingBody.error).toContain("criteria/missing.md");
    expect(missingBody.error).not.toContain(dir);
    expect(missingBody.error).toContain("examples/criteria/example-profile.md");
    expect(missingBody.error).toContain("profile_id");
    expect(existsSync(join(dir, "profiles.yaml"))).toBe(false);

    writeCriteria(dir, "demo.md", "example");
    const mismatched = await api.post("/api/profiles", profileBody(signer, "criteria/demo.md"));
    const mismatchedBody = (await mismatched.json()) as { error?: string; readNip65?: boolean; allowPublicRelays?: boolean };
    expect(mismatched.status).toBe(400);
    expect(mismatchedBody.error).toContain("criteria/demo.md");
    expect(mismatchedBody.error).toContain("example");
    expect(mismatchedBody.error).toContain("desk");
    expect(existsSync(join(dir, "profiles.yaml"))).toBe(false);

    writeCriteria(dir, "demo.md", "desk");
    const created = await api.post("/api/profiles", profileBody(signer, "criteria/demo.md"));
    const saved = (await created.json()) as { readNip65?: boolean; allowPublicRelays?: boolean; relays?: { url: string; publish: boolean }[] };
    expect(created.status).toBe(201);
    expect(saved.readNip65).toBe(false);
    expect(saved.allowPublicRelays).toBe(false);
    expect(saved.relays?.[0]?.publish).toBe(true);
    close();
  });

  test("a suggestion with the example profile_id is not stored, and approving one still records feedback", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    writeCriteria(dir, "demo.md", "example");
    writeProfile(dir, signer, "demo.md");
    const clock = 1_700_000_000;
    const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    const api = await authed(app);
    const draft = { type: "note", content: "A local note about the queue.", proposedFireAt: clock + 3600 };
    const failed = await api.post("/api/suggestions", { profileId: "desk", rationale: "because", draft, origin: "manual" });
    const failedBody = (await failed.json()) as { error?: string };
    expect(failed.status).toBe(400);
    expect(failedBody.error).toContain("criteria/demo.md");
    expect(failedBody.error).not.toContain(dir);
    expect(failedBody.error).toContain("example");
    expect(failedBody.error).toContain("desk");
    const hidden = (await (await api.get("/api/items?profileId=desk")).json()) as { status: string }[];
    expect(hidden.map((item) => item.status)).toEqual([]);
    expect(existsSync(feedbackPath(join(dir, "criteria", "demo.md"), "desk"))).toBe(false);

    writeCriteria(dir, "demo.md", "desk");
    const suggested = await api.post("/api/suggestions", { profileId: "desk", rationale: "because", draft, origin: "manual" });
    const suggestedBody = (await suggested.json()) as { id?: string; status?: string; origin?: string };
    expect(suggested.status).toBe(200);
    expect(suggestedBody.status).toBe("suggestion");
    expect(suggestedBody.origin).toBe("suggestion");
    const approved = await api.post(`/api/items/${suggestedBody.id}/approve`, {});
    const approvedBody = (await approved.json()) as { status?: string; origin?: string };
    expect(approved.status).toBe(200);
    expect(approvedBody.status).toBe("approved");
    expect(approvedBody.origin).toBe("suggestion");
    const feedback = readFeedback(feedbackPath(join(dir, "criteria", "demo.md"), "desk"));
    expect(feedback.map((entry) => entry.action)).toEqual(["approved"]);
    close();
  });

  test("a feedback write failure leaves the item unchanged, and the same request can be retried", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    writeCriteria(dir, "demo.md", "desk");
    writeProfile(dir, signer, "demo.md");
    const clock = 1_700_000_000;
    const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    const api = await authed(app);
    const suggested = await api.post("/api/suggestions", {
      profileId: "desk",
      rationale: "because",
      draft: { type: "note", content: "Held note", proposedFireAt: clock + 3600 },
    });
    const suggestion = (await suggested.json()) as { id: string; status: string };
    expect(suggested.status).toBe(200);
    expect(suggestion.status).toBe("suggestion");
    const blocked = join(dir, "criteria", "desk.feedback.yaml");
    mkdirSync(blocked);
    const failed = await api.post(`/api/items/${suggestion.id}/approve`, {});
    expect(failed.status).toBe(400);
    const during = (await (await api.get("/api/items?profileId=desk")).json()) as { id: string; status: string }[];
    expect(during.map((item) => ({ id: item.id, status: item.status }))).toEqual([{ id: suggestion.id, status: "suggestion" }]);
    rmSync(blocked, { recursive: true, force: true });
    const retried = await api.post(`/api/items/${suggestion.id}/approve`, {});
    const retriedBody = (await retried.json()) as { status?: string };
    expect(retried.status).toBe(200);
    expect(retriedBody.status).toBe("approved");
    const after = (await (await api.get("/api/items?profileId=desk")).json()) as { status: string }[];
    expect(after.map((item) => item.status)).toEqual(["approved"]);
    const feedback = readFeedback(feedbackPath(join(dir, "criteria", "demo.md"), "desk"));
    expect(feedback.map((entry) => entry.action)).toEqual(["approved"]);
    const again = await api.post(`/api/items/${suggestion.id}/approve`, {});
    expect(again.status).toBe(400);
    const still = (await (await api.get("/api/items?profileId=desk")).json()) as { status: string }[];
    expect(still.map((item) => item.status)).toEqual(["approved"]);
    expect(readFeedback(feedbackPath(join(dir, "criteria", "demo.md"), "desk")).map((entry) => entry.action)).toEqual(["approved"]);
    close();
  });

  test("a feedback write that lands and then fails rolls the note back", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    writeCriteria(dir, "demo.md", "desk");
    writeProfile(dir, signer, "demo.md");
    const clock = 1_700_000_000;
    const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    const api = await authed(app);
    const suggested = await api.post("/api/suggestions", {
      profileId: "desk",
      rationale: "because",
      draft: { type: "note", content: "Held note", proposedFireAt: clock + 3600 },
    });
    const suggestion = (await suggested.json()) as { id: string };
    const file = feedbackPath(join(dir, "criteria", "demo.md"), "desk");
    armFeedbackWriteFailure();
    const failed = await api.post(`/api/items/${suggestion.id}/approve`, {});
    expect(failed.status).toBe(400);
    const during = (await (await api.get("/api/items?profileId=desk")).json()) as { status: string }[];
    expect(during.map((item) => item.status)).toEqual(["suggestion"]);
    expect(existsSync(file)).toBe(false);
    const retried = await api.post(`/api/items/${suggestion.id}/approve`, {});
    expect(retried.status).toBe(200);
    expect(readFeedback(file).map((entry) => entry.suggestionId)).toEqual([suggestion.id]);
    close();
  });

  test("a failed feedback restore does not let a later rollback erase a newer line", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    writeCriteria(dir, "demo.md", "desk");
    writeProfile(dir, signer, "demo.md");
    const clock = 1_700_000_000;
    const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    const api = await authed(app);
    const make = async (content: string) => {
      const response = await api.post("/api/suggestions", {
        profileId: "desk",
        rationale: "because",
        draft: { type: "note", content, proposedFireAt: clock + 3600 },
      });
      return ((await response.json()) as { id: string }).id;
    };
    const first = await make("First");
    expect((await api.post(`/api/items/${first}/approve`, {})).status).toBe(200);
    const second = await make("Second");
    const third = await make("Third");
    const file = feedbackPath(join(dir, "criteria", "demo.md"), "desk");
    armFeedbackWriteFailure();
    armFeedbackRestoreFailure();
    expect((await api.post(`/api/items/${second}/approve`, {})).status).toBe(400);
    const during = (await (await api.get("/api/items?profileId=desk")).json()) as { id: string; status: string }[];
    expect(during.find((item) => item.id === second)?.status).toBe("suggestion");
    expect(readFeedback(file).map((entry) => entry.suggestionId)).toEqual([first, second]);
    armFeedbackWriteFailure();
    expect((await api.post(`/api/items/${third}/approve`, {})).status).toBe(400);
    expect(readFeedback(file).map((entry) => entry.suggestionId)).toEqual([first, second]);
    expect((await api.post(`/api/items/${second}/approve`, {})).status).toBe(200);
    const lines = readFeedback(file);
    expect(lines.filter((entry) => entry.suggestionId === second)).toHaveLength(1);
    expect((await (await api.get("/api/items?profileId=desk")).json() as { id: string; status: string }[]).find((item) => item.id === second)?.status).toBe("approved");
    close();
  });

  test("a label check names a mismatched criteria file before save", async () => {
    const dir = tempDir();
    writeCriteria(dir, "demo.md", "example");
    const { app, close } = createApp({ dataDir: dir });
    const api = await authed(app);
    const response = await api.get("/api/criteria-path?path=criteria/demo.md&label=Desk");
    const body = (await response.json()) as { ready?: boolean; detail?: string; path?: string };
    expect(response.status).toBe(200);
    expect(body.ready).toBe(false);
    expect(body.path).toBe("criteria/demo.md");
    expect(body.detail).toContain("profile_id example");
    expect(body.detail).toContain("desk");
    expect(body.detail).not.toContain(dir);
    close();
  });

  test("catch-up marks a late signed note missed after the criteria file is gone", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    writeCriteria(dir, "demo.md", "desk");
    writeProfile(dir, signer, "demo.md");
    const clock = 1_700_000_000;
    const { app, store, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    const api = await authed(app);
    const profile = loadProfiles(join(dir, "profiles.yaml"), { NOSTR_SCHEDULER_MODE: "test" })[0];
    if (!profile) throw new Error("missing profile");
    const queue = async (content: string, at: number) => {
      const response = await api.post("/api/suggestions", {
        profileId: "desk",
        rationale: "because",
        draft: { type: "note", content, proposedFireAt: at },
      });
      const id = suggestionId(((await response.json()) as { id: string }).id);
      store.transition(id, { type: "approve" }, unixSeconds(clock), profile);
      const signed = await signer.signEvent({ kind: 1, pubkey: signer.pubkey, created_at: unixSeconds(at), tags: [], content });
      store.transition(id, { type: "sign", events: [signed] }, unixSeconds(clock));
      store.transition(id, { type: "enqueue" }, unixSeconds(clock));
      return id;
    };
    const late = await queue("Late note", clock - 10_000);
    const future = await queue("Future note", clock + 3600);
    rmSync(join(dir, "criteria", "demo.md"));
    const summary = await publishDue({
      store,
      profiles: [profile],
      transport: { publish: async () => { throw new Error("not due"); } },
      now: () => unixSeconds(clock),
      windowSeconds: 60,
      sleep: async () => undefined,
      delays: [],
    });
    expect(summary.missed).toBe(1);
    expect(summary.waiting).toBe(1);
    expect(store.get(late).status).toBe("missed");
    expect(store.get(future).status).toBe("queued");
    close();
  });
});
