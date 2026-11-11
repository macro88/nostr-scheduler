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
});
