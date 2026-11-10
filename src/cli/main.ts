#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseCriteria } from "../criteria/parse.ts";
import { unixSeconds, type SuggestionId } from "../domain/brand.ts";
import { parseDraft } from "../domain/draft.ts";
import { catchUpWindowSeconds, signAheadSeconds } from "../domain/defaults.ts";
import type { Draft, Profile, Signer } from "../domain/types.ts";
import { serveMcp } from "../mcp/server.ts";
import { loadProfiles } from "../profiles/load.ts";
import { publishDue } from "../publisher/publish.ts";
import { signApproved, systemNow } from "../signers/batch.ts";
import { connectBunker } from "../signers/nip46.ts";
import { openNip07 } from "../signers/nip07.ts";
import { createNip55Signer } from "../signers/nip55.ts";
import { publishToRelay } from "../test-relay/client.ts";
import { WorkStore } from "../work/store.ts";

function openData(dataDir: string): { profiles: Profile[]; store: WorkStore } {
  return {
    profiles: loadProfiles(join(dataDir, "profiles.yaml")),
    store: new WorkStore(join(dataDir, "app.sqlite")),
  };
}

function profileFor(profiles: readonly Profile[], id: string): Profile {
  const found = profiles.find((profile) => profile.id === id);
  if (!found) throw new Error(`no profile ${id}`);
  return found;
}

async function signerFor(profile: Profile, dataDir: string): Promise<Signer> {
  if (profile.signer.kind === "mock") {
    throw new Error("the mock signer stays inside the local demo and does not keep an account key");
  }
  if (profile.signer.kind === "nip55") return createNip55Signer(profile.pubkey);
  if (profile.signer.kind === "nip07") {
    return {
      ref: profile.signer,
      pubkey: profile.pubkey,
      async signEvent(event) {
        const opened = await openNip07({ events: [event], expectedPubkey: profile.pubkey });
        console.error(`sign at ${opened.session.url}`);
        const signed = await opened.signed;
        await opened.session.close();
        const first = signed[0];
        if (!first) throw new Error("browser signer returned nothing");
        return first;
      },
    };
  }
  return connectBunker({
    bunkerUri: profile.signer.bunkerUri,
    userPubkey: profile.pubkey,
    sessionDir: join(dataDir, "nip46"),
    now: systemNow,
  });
}

function editedDraft(current: Draft, content: string, segment: string | undefined): Draft {
  if (current.type === "note" || current.type === "reply") return { ...current, content };
  const index = Number(segment ?? "0");
  if (!Number.isInteger(index) || index < 0 || index >= current.segments.length) {
    throw new Error("segment is outside the thread");
  }
  const segments = current.segments.map((part, i) => (i === index ? { ...part, content } : part));
  const [first, second, ...rest] = segments;
  if (!first || !second) throw new Error("a thread needs a root and a reply");
  return { type: "thread", segments: [first, second, ...rest] };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      data: { type: "string", default: "data" },
      reason: { type: "string" },
      content: { type: "string" },
      segment: { type: "string" },
      watch: { type: "boolean", default: false },
    },
  });
  const dataDir = resolve(values.data ?? "data");
  const [command, first, second] = positionals;
  if (!command || command === "help") {
    console.log("commands: criteria validate <file> | status | approve <id> | reject <id> | edit <id> | sign [id] | publish | mcp");
    return;
  }
  if (command === "criteria" && first === "validate") {
    const text = readFileSync(second ?? "examples/criteria/example-profile.md", "utf8");
    const criteria = parseCriteria(text);
    console.log(`${criteria.profileId} ${criteria.version}`);
    return;
  }
  const { profiles, store } = openData(dataDir);
  const now = () => unixSeconds(Math.floor(Date.now() / 1000));
  try {
    if (command === "status") {
      for (const item of store.list()) console.log(`${item.id} ${item.profileId} ${item.status}`);
      return;
    }
    if (command === "mcp") {
      serveMcp({ profiles, store, now });
      return;
    }
    if (command === "approve" || command === "reject" || command === "edit") {
      if (!first) throw new Error("missing id");
      const id = first as SuggestionId;
      const item = store.get(id);
      const profile = profileFor(profiles, item.profileId);
      if (command === "approve") store.transition(id, { type: "approve" }, now(), profile);
      if (command === "reject") store.transition(id, { type: "reject", reason: values.reason ?? "" }, now(), profile);
      if (command === "edit") {
        if (!values.content) throw new Error("missing content");
        if (item.status !== "suggestion" && item.status !== "approved") throw new Error(`cannot edit a ${item.status} item`);
        const draft = parseDraft(editedDraft(item.draft, values.content, values.segment));
        store.transition(id, { type: "edit", draft }, now(), profile);
      }
      console.log(store.get(id).status);
      return;
    }
    if (command === "sign") {
      const ids = first
        ? [first as SuggestionId]
        : store.list().filter((item) => item.status === "approved").map((item) => item.id);
      for (const id of ids) {
        const item = store.get(id);
        if (item.status !== "approved") throw new Error(`cannot sign a ${item.status} item`);
        const profile = profileFor(profiles, item.profileId);
        const signer = await signerFor(profile, dataDir);
        const signed = await signApproved({
          signer,
          item,
          now: now(),
          maxAheadSeconds: signAheadSeconds(),
          relayHint: profile.relays.configured[0],
        });
        store.transition(id, { type: "sign", events: [...signed.events] }, signed.signedAt);
        store.transition(id, { type: "enqueue" }, signed.signedAt);
        console.log(`${id} queued ${signed.events.map((event) => event.id).join(",")}`);
      }
      return;
    }
    if (command === "publish") {
      const tick = () =>
        publishDue({
          store,
          profiles,
          transport: { publish: publishToRelay },
          now,
          windowSeconds: catchUpWindowSeconds(),
        });
      const summary = await tick();
      console.log(JSON.stringify(summary));
      if (values.watch) {
        const timer = setInterval(() => {
          void tick().then((next) => console.log(JSON.stringify(next)));
        }, 1000);
        process.on("SIGINT", () => {
          clearInterval(timer);
          store.close();
          process.exit(0);
        });
        return;
      }
      return;
    }
    throw new Error(`unknown command ${command}`);
  } finally {
    if (command !== "mcp" && !(command === "publish" && values.watch)) store.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "failed");
    process.exit(1);
  });
}
