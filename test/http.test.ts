import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { unixSeconds } from "../src/domain/brand.ts";
import { createApp } from "../src/http/app.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { LocalRelay } from "../src/test-relay/relay.ts";
import { readFeedback, feedbackPath } from "../src/criteria/feedback.ts";

const example = readFileSync(new URL("../examples/criteria/example-profile.md", import.meta.url), "utf8");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sched-ui-"));
}

function writeProfile(dir: string, signer: ReturnType<typeof createMockSigner>, relay: string, id = "demo") {
  const criteria = join(dir, "criteria.md");
  writeFileSync(criteria, example.replace("profile_id: example", `profile_id: ${id}`));
  writeFileSync(
    join(dir, "profiles.yaml"),
    [
      "profiles:",
      `  - id: ${id}`,
      "    label: Demo",
      `    npub: ${signer.npub}`,
      `    pubkey: ${signer.pubkey}`,
      "    suggester_id: demo-suggester",
      "    signer:",
      "      kind: mock",
      "    relays:",
      `      - ${relay}`,
      "    read_nip65: false",
      "    criteria_path: criteria.md",
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
    headers,
    post: (path: string, payload: unknown) =>
      app.request(`http://127.0.0.1:4173${path}`, { method: "POST", headers, body: JSON.stringify(payload) }),
    get: (path: string) => app.request(`http://127.0.0.1:4173${path}`, { headers: { host: headers.host, cookie } }),
  };
}

describe("local api", () => {
  test("rejects a foreign host and a missing session token", async () => {
    const dir = tempDir();
    const { app, close } = createApp({ dataDir: dir });
    const foreign = await app.request("http://evil.example/api/profiles", { headers: { host: "evil.example" } });
    expect(foreign.status).toBe(403);
    const open = await authed(app);
    const denied = await app.request("http://127.0.0.1:4173/api/publish", {
      method: "POST",
      headers: { host: "127.0.0.1:4173", origin: "http://127.0.0.1:4173" },
    });
    expect(denied.status).toBe(403);
    const ok = await open.get("/api/profiles");
    expect(ok.status).toBe(200);
    close();
  });

  test("reviews a suggestion, signs it in the browser, and publishes on the local relay", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    const relay = new LocalRelay();
    const url = await relay.start();
    writeProfile(dir, signer, url);
    let clock = 1_700_000_000;
    const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    const api = await authed(app);
    const suggested = await api.post("/api/suggestions", {
      profileId: "demo",
      rationale: "because",
      draft: { type: "note", content: "First draft", proposedFireAt: clock + 30 },
    });
    const suggestion = (await suggested.json()) as { id: string; error?: string };
    if (suggested.status !== 200) throw new Error(`suggest ${suggested.status} ${JSON.stringify(suggestion)}`);
    const edited = await api.post(`/api/items/${suggestion.id}/edit`, {
      draft: { type: "note", content: "Clearer draft", proposedFireAt: clock + 30 },
    });
    const editedBody = await edited.json();
    expect(edited.status, JSON.stringify(editedBody)).toBe(200);
    expect(editedBody.preview).toBe("Clearer draft");
    const approved = await api.post(`/api/items/${suggestion.id}/approve`, {});
    expect((await approved.json()).status).toBe("approved");
    const rejected = await api.post("/api/suggestions", {
      profileId: "demo",
      rationale: "off",
      draft: { type: "note", content: "Invest now", proposedFireAt: clock + 40 },
    });
    const rejectedId = ((await rejected.json()) as { id: string }).id;
    const rejection = await api.post(`/api/items/${rejectedId}/reject`, { reason: "off the brief" });
    expect((await rejection.json()).status).toBe("rejected");
    const feedback = readFeedback(feedbackPath(join(dir, "criteria.md"), "demo"));
    expect(feedback.map((entry) => entry.action)).toEqual(["edited", "approved", "rejected"]);

    const next = await api.post("/api/sign/nip07/next", { profileId: "demo" });
    const waiting = (await next.json()) as { unsigned: { content: string; pubkey: string; created_at: number; kind: 1; tags: [] } };
    expect(waiting.unsigned.content).toBe("Clearer draft");
    const signed = await signer.signEvent(waiting.unsigned as unknown as Parameters<typeof signer.signEvent>[0]);
    const submitted = await api.post("/api/sign/nip07/submit", { itemId: suggestion.id, event: signed });
    expect((await submitted.json()).done).toBe(true);

    const early = await api.post("/api/publish", {});
    expect(await early.json()).toMatchObject({ sent: 0, waiting: 1 });
    clock = clock + 30;
    const published = await api.post("/api/publish", {});
    expect(await published.json()).toMatchObject({ sent: 1 });
    const log = await api.get("/api/log");
    const rows = (await log.json()) as { status: string; results: { accepted: boolean }[] }[];
    expect(rows[0]?.status).toBe("sent");
    expect(rows[0]?.results.some((row) => row.accepted)).toBe(true);
    const frozen = await api.post(`/api/items/${suggestion.id}/reschedule`, { fireAt: clock + 90 });
    expect(frozen.status).toBe(409);

    close();
    await relay.stop();
  });

  test("reschedule moves a saved draft and keeps it a draft", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    writeProfile(dir, signer, "ws://127.0.0.1:9");
    const clock = 1_700_000_000;
    const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    const api = await authed(app);
    const saved = await api.post("/api/drafts", {
      profileId: "demo",
      draft: { type: "note", content: "Held note", proposedFireAt: clock + 3600 },
    });
    const draft = (await saved.json()) as { id: string; status: string; fireAt: number[]; preview: string };
    expect(saved.status, JSON.stringify(draft)).toBe(200);
    expect(draft).toMatchObject({ status: "draft", fireAt: [clock + 3600], preview: "Held note" });

    const moved = await api.post(`/api/items/${draft.id}/reschedule`, { fireAt: clock + 7200 });
    const body = (await moved.json()) as { status: string; fireAt: number[]; preview: string; draft?: { proposedFireAt?: number } };
    expect(moved.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      status: "draft",
      fireAt: [clock + 7200],
      preview: "Held note",
      draft: { type: "note", content: "Held note", proposedFireAt: clock + 7200 },
    });

    const listed = (await (await api.get("/api/items?profileId=demo")).json()) as { id: string; status: string; fireAt: number[] }[];
    expect(listed.find((item) => item.id === draft.id)).toMatchObject({ status: "draft", fireAt: [clock + 7200] });
    close();
  });

  test("reschedule still moves a suggestion and an approved note", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    writeProfile(dir, signer, "ws://127.0.0.1:9");
    const clock = 1_700_000_000;
    const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    const api = await authed(app);
    const suggested = await api.post("/api/suggestions", {
      profileId: "demo",
      rationale: "because",
      draft: { type: "note", content: "Suggested note", proposedFireAt: clock + 3600 },
    });
    const suggestion = (await suggested.json()) as { id: string; status: string };
    expect(suggested.status).toBe(200);
    const suggestionMoved = await api.post(`/api/items/${suggestion.id}/reschedule`, { fireAt: clock + 5400 });
    expect(suggestionMoved.status).toBe(200);
    expect(await suggestionMoved.json()).toMatchObject({ status: "suggestion", fireAt: [clock + 5400], preview: "Suggested note" });

    const composed = await api.post("/api/compose", {
      profileId: "demo",
      draft: { type: "note", content: "Approved note", proposedFireAt: clock + 3600 },
    });
    const approved = (await composed.json()) as { id: string; status: string };
    expect(composed.status).toBe(200);
    const approvedMoved = await api.post(`/api/items/${approved.id}/reschedule`, { fireAt: clock + 9000 });
    expect(approvedMoved.status).toBe(200);
    expect(await approvedMoved.json()).toMatchObject({ status: "approved", fireAt: [clock + 9000], preview: "Approved note" });
    close();
  });

  test("reschedule refuses a queued note and leaves its time", async () => {
    const dir = tempDir();
    const signer = createMockSigner();
    writeProfile(dir, signer, "ws://127.0.0.1:9");
    const clock = 1_700_000_000;
    const { app, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    const api = await authed(app);
    const composed = await api.post("/api/compose", {
      profileId: "demo",
      draft: { type: "note", content: "Queued note", proposedFireAt: clock + 3600 },
    });
    const created = (await composed.json()) as { id: string };
    expect(composed.status).toBe(200);
    const next = await api.post("/api/sign/nip07/next", { profileId: "demo" });
    const waiting = (await next.json()) as { unsigned: Parameters<typeof signer.signEvent>[0] };
    expect(next.status, JSON.stringify(waiting)).toBe(200);
    const signed = await signer.signEvent(waiting.unsigned);
    const submitted = await api.post("/api/sign/nip07/submit", { itemId: created.id, event: signed });
    const queued = (await submitted.json()) as { done?: boolean; item?: { status: string } };
    expect(submitted.status, JSON.stringify(queued)).toBe(200);
    expect(queued.done).toBe(true);
    expect(queued.item?.status).toBe("queued");

    const frozen = await api.post(`/api/items/${created.id}/reschedule`, { fireAt: clock + 7200 });
    expect(frozen.status).toBe(409);
    expect(await frozen.json()).toEqual({
      error: "A signed event is frozen. Discard it and sign again to choose a new time.",
    });
    const rows = (await (await api.get("/api/items?profileId=demo")).json()) as { status: string; fireAt: number[] }[];
    expect(rows).toEqual([expect.objectContaining({ status: "queued", fireAt: [clock + 3600] })]);
    close();
  });
});
