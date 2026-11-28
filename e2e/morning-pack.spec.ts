import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Page } from "@playwright/test";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { ResearchStore } from "../src/research/store.ts";
import { LocalRelay } from "../src/test-relay/relay.ts";

const dataDir = "e2e/run";
const example = readFileSync(new URL("../examples/criteria/example-profile.md", import.meta.url), "utf8");

function profileFile(signer: { npub: string; pubkey: string }, relay: string) {
  mkdirSync(`${dataDir}/criteria`, { recursive: true });
  writeFileSync(`${dataDir}/criteria/demo.md`, example.replace("profile_id: example", "profile_id: demo"));
  writeFileSync(
    `${dataDir}/profiles.yaml`,
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
      `      - ${relay}`,
      "    read_nip65: false",
      "    criteria_path: criteria/demo.md",
      "",
    ].join("\n"),
  );
}

async function post(page: Page, path: string, payload: unknown) {
  return page.evaluate(
    async ({ path, payload }) => {
      const session = (await fetch("/api/session").then((response) => response.json())) as { token: string };
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": session.token },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    { path, payload },
  );
}

test("shows a morning pack and leaves briefs unqueued", async ({ page }) => {
  const relay = new LocalRelay();
  const url = await relay.start();
  profileFile(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }), url);
  const createdAt = Math.floor(Date.now() / 1000);
  const briefs = ["Relay fees", "Client bugs", "Long form", "Zaps", "Lists"].map((title, index) => ({
    kind: "brief",
    id: `res_pack${index}a`,
    profileId: "demo",
    title,
    summary: `${title} is research, not a draft.`,
    ...(index === 0 ? { url: "https://example.com/brief" } : {}),
    createdAt,
  }));
  const db = new DatabaseSync(`${dataDir}/research.sqlite`, { timeout: 5000 });
  db.exec("DELETE FROM research_records");
  db.close();
  const research = new ResearchStore(`${dataDir}/research.sqlite`);
  try {
    for (const brief of briefs) research.insertFixture(brief);
  } finally {
    research.close();
  }

  await page.goto("/");
  const existing = (await page.evaluate(async () => {
    const response = await fetch("/api/items?profileId=demo");
    return response.json();
  })) as { id: string; status: string }[];
  for (const item of existing) {
    if (item.status === "suggestion") await post(page, `/api/items/${item.id}/reject`, { reason: "clear" });
    if (["approved", "signed", "queued", "failed"].includes(item.status)) {
      await post(page, `/api/items/${item.id}/discard`, { reason: "clear" });
    }
  }
  const fireAt = createdAt + 3600;
  const drafts = [
    ["#morning", "Pack alpha"],
    ["#morning", "Pack beta"],
    ["#morning", "Pack gamma"],
    ["because", "Ordinary one"],
    ["notes", "Ordinary two"],
  ] as const;
  for (const [rationale, content] of drafts) {
    await post(page, "/api/suggestions", {
      profileId: "demo",
      rationale,
      draft: { type: "note", content, proposedFireAt: fireAt },
    });
  }
  await page.reload();
  await expect(page.getByRole("heading", { name: "Morning pack" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Daily brief" })).toBeVisible();
  for (const title of ["Pack alpha", "Pack beta", "Pack gamma", "Ordinary one", "Ordinary two"]) {
    await expect(page.getByTestId("suggestion").filter({ hasText: title })).toBeVisible();
  }
  await expect(page.getByTestId("brief")).toHaveCount(5);
  await expect(page.getByTestId("brief").getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("brief").first().getByRole("link")).toHaveAttribute("href", "https://example.com/brief");
  await expect(page.getByText("Research only. Remix a brief before it can be approved.")).toBeVisible();

  const selected = (await page.locator(".detail-note").textContent()) ?? "";
  await page.getByTestId("approve").click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Approved" })).toBeVisible();
  await expect(page.getByTestId("suggestion").filter({ hasText: selected })).toHaveCount(0);
  await expect(page.getByTestId("suggestion")).toHaveCount(4);
  await expect(page.getByTestId("brief")).toHaveCount(5);

  const after = await page.evaluate(async () => {
    const items = (await fetch("/api/items?profileId=demo").then((response) => response.json())) as { status: string; preview: string }[];
    const listed = (await fetch("/api/research?profileId=demo").then((response) => response.json())) as { kind: string; title?: string }[];
    return { items, listed };
  });
  expect(after.items.filter((item) => item.status === "approved")).toHaveLength(1);
  expect(after.items.some((item) => item.status === "queued" || item.status === "signed" || item.status === "sent")).toBe(false);
  expect(JSON.stringify(after.items)).not.toContain("is research, not a draft");
  expect(after.listed.filter((item) => item.kind === "brief").map((item) => item.title).sort()).toEqual([
    "Client bugs",
    "Lists",
    "Long form",
    "Relay fees",
    "Zaps",
  ]);
  const cleanup = new DatabaseSync(`${dataDir}/research.sqlite`, { timeout: 5000 });
  try {
    cleanup.exec("DELETE FROM research_records");
  } finally {
    cleanup.close();
  }
  await relay.stop();
});
