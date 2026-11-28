import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { unixSeconds } from "../src/domain/brand.ts";
import { groupSuggestions, selectBriefs, type PackInput } from "../src/domain/pack.ts";
import { createApp } from "../src/http/app.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";

const morning = Math.floor(Date.UTC(2026, 10, 28, 8, 0, 0) / 1000);
const previous = Math.floor(Date.UTC(2026, 10, 27, 15, 0, 0) / 1000);
const example = readFileSync(new URL("../examples/criteria/example-profile.md", import.meta.url), "utf8");

function row(id: string, createdAt: number, rationale: string): PackInput {
  return { id, createdAt, rationale };
}

function idsOf(groups: readonly { items: readonly { id: string }[] }[]): string[] {
  return groups.flatMap((group) => group.items.map((item) => item.id));
}

describe("groupSuggestions", () => {
  test("keeps every suggestion and splits tags from created days", () => {
    const items = [
      row("later", morning, "#later after lunch"),
      row("pack-a", morning, "Draft for #Morning"),
      row("plain", morning, "because"),
      row("old", previous, ""),
      row("pack-b", morning, "second #morning note"),
    ];
    const groups = groupSuggestions(items, { timeZone: "UTC", now: morning });
    expect(idsOf(groups).sort()).toEqual(["later", "old", "pack-a", "pack-b", "plain"]);
    expect(new Set(idsOf(groups)).size).toBe(items.length);
    expect(groups.map((group) => ({ by: group.by, key: group.key, label: group.label, ids: group.items.map((item) => item.id) }))).toEqual([
      { by: "tag", key: "morning", label: "Morning pack", ids: ["pack-a", "pack-b"] },
      { by: "tag", key: "later", label: "Later", ids: ["later"] },
      { by: "day", key: "2026-11-28", label: "Today", ids: ["plain"] },
      { by: "day", key: "2026-11-27", label: "27 Nov", ids: ["old"] },
    ]);
  });

  test("calls today's untagged suggestions the morning pack", () => {
    const items = [row("plain", morning, "because"), row("old", previous, "notes")];
    const groups = groupSuggestions(items, { timeZone: "UTC", now: morning });
    expect(groups.map((group) => ({ label: group.label, ids: group.items.map((item) => item.id) }))).toEqual([
      { label: "Morning pack", ids: ["plain"] },
      { label: "27 Nov", ids: ["old"] },
    ]);
    expect(groups[0]?.by).toBe("day");
  });

  test("uses the requested time zone for the created day", () => {
    const justAfterUtcMidnight = Math.floor(Date.UTC(2026, 10, 28, 0, 30, 0) / 1000);
    const item = [row("edge", justAfterUtcMidnight, "because")];
    expect(groupSuggestions(item, { timeZone: "UTC", now: justAfterUtcMidnight })[0]?.key).toBe("2026-11-28");
    expect(groupSuggestions(item, { timeZone: "America/Los_Angeles", now: justAfterUtcMidnight })[0]?.key).toBe("2026-11-27");
  });

  test("returns no groups for an empty inbox", () => {
    expect(groupSuggestions([], { timeZone: "UTC", now: morning })).toEqual([]);
  });
});

describe("selectBriefs", () => {
  test("keeps brief rows and drops other research", () => {
    const briefs = selectBriefs([
      { kind: "outlier", id: "res_out", title: "nope", summary: "nope" },
      { kind: "brief", id: "res_brief", title: "Desk", summary: "Five notes.", url: "https://example.com/a" },
      { kind: "source", id: "res_src", content: "source text" },
      { kind: "brief", id: "res_note", title: "No link", summary: "A note." },
      { kind: "brief", id: "res_bad", title: "Blocked", summary: "Script.", url: "javascript:alert(1)" },
      { kind: "brief", title: "Missing id", summary: "Skip." },
    ]);
    expect(briefs).toEqual([
      { id: "res_brief", title: "Desk", summary: "Five notes.", url: "https://example.com/a" },
      { id: "res_note", title: "No link", summary: "A note." },
      { id: "res_bad", title: "Blocked", summary: "Script." },
    ]);
    expect(briefs[2]?.url).toBeUndefined();
  });
});

function writeProfile(dir: string, signer: ReturnType<typeof createMockSigner>) {
  const criteria = join(dir, "criteria.md");
  writeFileSync(criteria, example.replace("profile_id: example", "profile_id: demo"));
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
      "      - ws://127.0.0.1:9",
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
    get: (path: string) => app.request(`http://127.0.0.1:4173${path}`, { headers: { host: headers.host, cookie } }),
    post: (path: string, payload: unknown) =>
      app.request(`http://127.0.0.1:4173${path}`, { method: "POST", headers, body: JSON.stringify(payload) }),
  };
}

type ListedItem = {
  id: string;
  status: string;
  createdAt?: number;
  rationale?: string;
  preview: string;
};

describe("morning pack live", () => {
  test("approves one suggestion and leaves briefs unsigned and unqueued", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morning-pack-"));
    writeProfile(dir, createMockSigner());
    let clock = morning;
    const { app, research, store, close } = createApp({ dataDir: dir, now: () => unixSeconds(clock) });
    try {
      const api = await authed(app);
      const briefs = ["Relay fees", "Client bugs", "Long form", "Zaps", "Lists"].map((title, index) => ({
        kind: "brief",
        id: `res_brief0${index + 1}`,
        profileId: "demo",
        title,
        summary: `${title} is research, not a draft.`,
        url: index === 0 ? "https://example.com/brief" : undefined,
        createdAt: morning,
      }));
      for (const brief of briefs) research.insertFixture(brief);
      const before = JSON.stringify(await (await api.get("/api/research?profileId=demo")).json());

      const drafts = [
        { rationale: "#morning one", content: "Morning one" },
        { rationale: "#morning two", content: "Morning two" },
        { rationale: "#later", content: "Later note" },
        { rationale: "because", content: "Ordinary today" },
      ];
      const ids: string[] = [];
      for (const draft of drafts) {
        const saved = await api.post("/api/suggestions", {
          profileId: "demo",
          rationale: draft.rationale,
          draft: { type: "note", content: draft.content, proposedFireAt: morning + 86_400 },
        });
        expect(saved.status).toBe(200);
        ids.push(((await saved.json()) as { id: string }).id);
      }
      clock = previous;
      const older = await api.post("/api/suggestions", {
        profileId: "demo",
        rationale: "notes",
        draft: { type: "note", content: "Ordinary yesterday", proposedFireAt: morning + 86_400 },
      });
      expect(older.status).toBe(200);
      ids.push(((await older.json()) as { id: string }).id);

      const listed = (await (await api.get("/api/items?profileId=demo")).json()) as ListedItem[];
      expect(listed.map((item) => item.status)).toEqual(["suggestion", "suggestion", "suggestion", "suggestion", "suggestion"]);
      expect(listed.every((item) => typeof item.createdAt === "number")).toBe(true);
      const groups = groupSuggestions(
        listed.map((item) => ({ id: item.id, createdAt: item.createdAt ?? 0, rationale: item.rationale ?? "" })),
        { timeZone: "UTC", now: morning },
      );
      expect(idsOf(groups).sort()).toEqual([...ids].sort());
      const morningIds = listed.filter((item) => (item.rationale ?? "").toLowerCase().includes("#morning")).map((item) => item.id);
      expect(groups.find((group) => group.label === "Morning pack")?.items.map((item) => item.id)).toEqual(morningIds);
      expect(groups.map((group) => group.label).sort()).toEqual(["27 Nov", "Later", "Morning pack", "Today"]);
      expect(JSON.stringify(listed)).not.toContain("res_brief");
      expect(JSON.stringify(listed)).not.toContain("is research, not a draft");

      const approved = await api.post(`/api/items/${ids[0]}/approve`, {});
      expect(approved.status).toBe(200);
      expect(await approved.json()).toMatchObject({ id: ids[0], status: "approved" });

      const afterItems = (await (await api.get("/api/items?profileId=demo")).json()) as ListedItem[];
      expect(afterItems.find((item) => item.id === ids[0])?.status).toBe("approved");
      expect(afterItems.filter((item) => item.status === "suggestion").map((item) => item.id).sort()).toEqual(ids.slice(1).sort());
      expect(afterItems.some((item) => item.status === "queued" || item.status === "signed" || item.status === "sent")).toBe(false);
      expect(JSON.stringify(afterItems)).not.toContain("res_brief");
      expect(JSON.stringify(await (await api.get("/api/research?profileId=demo")).json())).toBe(before);
      expect(store.list().map((item) => item.status).sort()).toEqual(["approved", "suggestion", "suggestion", "suggestion", "suggestion"]);
      expect(research.list().map((item) => item.kind)).toEqual(["brief", "brief", "brief", "brief", "brief"]);
    } finally {
      close();
    }
  });
});
