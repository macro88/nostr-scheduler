import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readFeedback, feedbackPath } from "../src/criteria/feedback.ts";
import { unixSeconds } from "../src/domain/brand.ts";
import { createApp } from "../src/http/app.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";

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
});
