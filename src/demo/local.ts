import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCriteria } from "../criteria/parse.ts";
import { readFileSync } from "node:fs";
import { suggestionId } from "../domain/brand.ts";
import { DEFAULT_CATCH_UP_SECONDS } from "../domain/defaults.ts";
import { callTool } from "../mcp/server.ts";
import { runtimeMode } from "../mode.ts";
import { createMockSigner } from "../mock-signer/index.ts";
import { loadProfiles } from "../profiles/load.ts";
import { publishDue, virtualClock } from "../publisher/publish.ts";
import { signApproved } from "../signers/batch.ts";
import { fetchFromRelay, publishToRelay } from "../test-relay/client.ts";
import { LocalRelay } from "../test-relay/relay.ts";
import { WorkStore } from "../work/store.ts";

const START = 1_700_000_000;
const EXAMPLE = new URL("../../examples/criteria/example-profile.md", import.meta.url);

export type DemoReport = {
  relay: string;
  sentId: string;
  futureId: string;
  missedId: string;
  sentOnRelay: boolean;
  futureOnRelay: boolean;
  missedOnRelay: boolean;
};

export async function runLocalDemo(dataDir: string): Promise<DemoReport> {
  const mode = runtimeMode();
  if (mode === "production") throw new Error("the local demo runs only in test or demo mode");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(join(dataDir, "criteria"), { recursive: true });
  const relay = new LocalRelay();
  const url = await relay.start();
  const signer = createMockSigner();
  const criteriaSource = readFileSync(EXAMPLE, "utf8").replace("profile_id: example", "profile_id: demo");
  const criteriaPath = join(dataDir, "criteria", "demo.md");
  writeFileSync(criteriaPath, criteriaSource);
  const profilesPath = join(dataDir, "profiles.yaml");
  writeFileSync(
    profilesPath,
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
      `      - ${url}`,
      "    read_nip65: false",
      "    criteria_path: criteria/demo.md",
      "",
    ].join("\n"),
  );
  const profiles = loadProfiles(profilesPath);
  const profile = profiles[0];
  if (!profile || profile.signer.kind !== "mock") throw new Error("demo profile was not created");
  const store = new WorkStore(join(dataDir, "app.sqlite"));
  const clock = virtualClock(START);
  const ctx = { profiles, store, now: () => clock.now() };
  try {
    const missedAt = START + 100;
    const dueAt = START + 5000;
    const futureAt = START + 2 * 24 * 60 * 60;
    const due = await callTool(ctx, "suggest_post", {
      profileId: "demo",
      suggesterId: "demo-suggester",
      rationale: "demo note",
      draft: { type: "note", content: "A local note, signed before it is sent.", proposedFireAt: dueAt },
    });
    const missed = await callTool(ctx, "suggest_post", {
      profileId: "demo",
      suggesterId: "demo-suggester",
      rationale: "late note",
      draft: { type: "note", content: "This one is outside the catch-up window.", proposedFireAt: missedAt },
    });
    const future = await callTool(ctx, "suggest_post", {
      profileId: "demo",
      suggesterId: "demo-suggester",
      rationale: "later note",
      draft: { type: "note", content: "This one stays queued.", proposedFireAt: futureAt },
    });
    const dueId = suggestionId((due as { id: string }).id);
    const missedIdSuggestion = suggestionId((missed as { id: string }).id);
    const futureSuggestion = suggestionId((future as { id: string }).id);
    for (const id of [dueId, missedIdSuggestion, futureSuggestion]) {
      store.transition(id, { type: "approve" }, clock.now(), profile);
      const item = store.get(id);
      if (item.status !== "approved") throw new Error("approval failed");
      const signed = await signApproved({
        signer,
        item,
        now: clock.now(),
        maxAheadSeconds: 7 * 24 * 60 * 60,
        relayHint: profile.relays.configured[0],
      });
      store.transition(id, { type: "sign", events: [...signed.events] }, clock.now());
      store.transition(id, { type: "enqueue" }, clock.now());
    }
    clock.advance(missedAt - START + DEFAULT_CATCH_UP_SECONDS + 1);
    await publishDue({
      store,
      profiles,
      transport: { publish: publishToRelay },
      now: () => clock.now(),
      windowSeconds: DEFAULT_CATCH_UP_SECONDS,
      sleep: async () => undefined,
      delays: [],
    });
    const gap = dueAt - clock.now();
    if (gap > 0) clock.advance(gap);
    await publishDue({
      store,
      profiles,
      transport: { publish: publishToRelay },
      now: () => clock.now(),
      windowSeconds: DEFAULT_CATCH_UP_SECONDS,
      sleep: async () => undefined,
      delays: [],
    });
    const sent = store.get(dueId);
    const late = store.get(missedIdSuggestion);
    const held = store.get(futureSuggestion);
    if (sent.status !== "sent" || late.status !== "missed" || held.status !== "queued") {
      throw new Error(`unexpected statuses ${sent.status} ${late.status} ${held.status}`);
    }
    const sentId = sent.events[0].id;
    const missedEventId = late.events[0].id;
    const futureId = held.events[0].id;
    const onRelay = async (id: string) => (await fetchFromRelay(url, { ids: [id] })).length > 0;
    const report: DemoReport = {
      relay: url,
      sentId,
      futureId,
      missedId: missedEventId,
      sentOnRelay: await onRelay(sentId),
      futureOnRelay: await onRelay(futureId),
      missedOnRelay: await onRelay(missedEventId),
    };
    if (!report.sentOnRelay || report.futureOnRelay || report.missedOnRelay) {
      throw new Error("relay contents did not match the publish decisions");
    }
    parseCriteria(readFileSync(criteriaPath, "utf8"), profile.id);
    return report;
  } finally {
    store.close();
    await relay.stop();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (runtimeMode() !== "demo") {
    console.error("demo:local runs only when NOSTR_SCHEDULER_MODE=demo");
    process.exit(1);
  }
  const dataDir = process.env.NOSTR_SCHEDULER_DATA ?? join(process.cwd(), "data", "demo");
  runLocalDemo(dataDir)
    .then((report) => {
      console.log(`relay ${report.relay}`);
      console.log(`sent ${report.sentId}`);
      console.log(`future ${report.futureId} queued`);
      console.log(`missed ${report.missedId} missed`);
      console.log(`sent-on-relay ${report.sentOnRelay ? "yes" : "no"}`);
      console.log(`future-on-relay ${report.futureOnRelay ? "yes" : "no"}`);
      console.log(`missed-on-relay ${report.missedOnRelay ? "yes" : "no"}`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "demo failed");
      process.exit(1);
    });
}
