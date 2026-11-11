import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { suggestionId } from "../domain/brand.ts";
import { parseDraft } from "../domain/draft.ts";
import { signAheadSeconds } from "../domain/defaults.ts";
import { systemNow } from "../signers/batch.ts";
import { connectBunker } from "../signers/nip46.ts";
import { loadOrCreateSession, wipeSession, type SessionLoadOptions } from "../signers/nip46-session.ts";
import { memorySessionStore } from "../signers/session-store.ts";
import { runtimeMode } from "../mode.ts";
import { loadProfiles } from "../profiles/load.ts";
import { publicSigner } from "../profiles/load.ts";
import { setProfileSigner } from "../profiles/save.ts";
import { publishDue } from "../publisher/publish.ts";
import { publishToRelay } from "../test-relay/client.ts";
import type { Profile, UnixSeconds } from "../domain/types.ts";
import { WorkStore } from "../work/store.ts";
import { contextFor } from "./context.ts";
import {
  acceptSigned,
  blankCursor,
  fireTimes,
  nextUnsigned,
  previewOf,
  shiftDraft,
  type SignCursor,
} from "./sign-batch.ts";
import {
  bunkerSchema,
  composeSchema,
  contextSchema,
  discardSchema,
  editSchema,
  profileActionSchema,
  rejectSchema,
  rescheduleSchema,
  signNextSchema,
  signSubmitSchema,
  suggestionSchema,
} from "./schema.ts";
import { createGuard, issueSession } from "./security.ts";

type Listener = (data: string) => void;

export type AppOptions = {
  dataDir: string;
  now?: () => UnixSeconds;
  staticDir?: string;
};

function itemView(item: ReturnType<WorkStore["get"]>) {
  const events =
    item.status === "signed" || item.status === "queued" || item.status === "sent" || item.status === "failed" || item.status === "missed"
      ? item.events.map((event) => ({
          id: event.id,
          content: event.content,
          created_at: event.created_at,
          tags: event.tags,
        }))
      : undefined;
  return {
    id: item.id,
    profileId: item.profileId,
    status: item.status,
    fireAt: fireTimes(item),
    preview: previewOf(item),
    rationale: "rationale" in item ? item.rationale : undefined,
    reason: "reason" in item ? item.reason : undefined,
    draft: "draft" in item ? item.draft : undefined,
    events,
    results: item.status === "sent" || item.status === "failed" ? item.results : undefined,
    lateBySeconds: item.status === "missed" ? item.lateBySeconds : undefined,
  };
}

export function createApp(options: AppOptions) {
  const profilesPath = join(options.dataDir, "profiles.yaml");
  const store = new WorkStore(join(options.dataDir, "app.sqlite"));
  const now = () => options.now?.() ?? systemNow();
  const guard = createGuard();
  const listeners = new Set<Listener>();
  const cursors = new Map<string, SignCursor>();
  const sessionOptions: SessionLoadOptions =
    runtimeMode() === "test" || runtimeMode() === "demo" ? { store: memorySessionStore() } : {};
  const notify = () => {
    for (const listener of listeners) listener("changed");
  };
  const profiles = (): Profile[] => (existsSync(profilesPath) ? loadProfiles(profilesPath) : []);
  const profile = (id: string) => {
    const found = profiles().find((item) => item.id === id);
    if (!found) throw new Error(`no profile ${id}`);
    return found;
  };
  const app = new Hono();
  app.use("*", guard.middleware);
  app.onError((error, c) => c.json({ error: error.message }, 400));

  app.get("/api/session", (c) => c.json({ token: issueSession(c, guard.sessions) }));
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const listener = (data: string) => {
        void stream.writeSSE({ data });
      };
      listeners.add(listener);
      stream.onAbort(() => {
        listeners.delete(listener);
      });
      await stream.writeSSE({ data: "ready" });
      while (!stream.aborted) {
        await stream.sleep(15000);
        await stream.writeSSE({ event: "ping", data: "1" });
      }
    }),
  );
  app.get("/api/profiles", (c) =>
    c.json(
      profiles().map((item) => ({
        id: item.id,
        label: item.label,
        pubkey: item.pubkey,
        signer: publicSigner(item).signer,
        timezone: "UTC",
      })),
    ),
  );
  app.get("/api/items", (c) => {
    const profileId = c.req.query("profileId");
    const items = store.list(profileId ? profile(profileId).id : undefined).map(itemView);
    return c.json(items);
  });
  app.post("/api/suggestions", async (c) => {
    const body = suggestionSchema.parse(await c.req.json());
    const owner = profile(body.profileId);
    const item = store.suggest({
      profile: owner,
      suggesterId: owner.suggesterId,
      draft: parseDraft(body.draft),
      rationale: body.rationale,
      at: now(),
    });
    notify();
    return c.json(itemView(item));
  });
  app.post("/api/compose", async (c) => {
    const body = composeSchema.parse(await c.req.json());
    const owner = profile(body.profileId);
    const suggested = store.suggest({
      profile: owner,
      suggesterId: owner.suggesterId,
      draft: parseDraft(body.draft),
      rationale: "composed locally",
      at: now(),
    });
    const approved = store.transition(suggested.id, { type: "approve" }, now(), owner);
    notify();
    return c.json(itemView(approved));
  });
  app.post("/api/items/:id/edit", async (c) => {
    const body = editSchema.parse(await c.req.json());
    const current = store.get(suggestionId(c.req.param("id")));
    const owner = profile(current.profileId);
    const next = store.transition(current.id, { type: "edit", draft: parseDraft(body.draft) }, now(), owner);
    notify();
    return c.json(itemView(next));
  });
  app.post("/api/items/:id/approve", (c) => {
    const current = store.get(suggestionId(c.req.param("id")));
    const next = store.transition(current.id, { type: "approve" }, now(), profile(current.profileId));
    notify();
    return c.json(itemView(next));
  });
  app.post("/api/items/:id/reject", async (c) => {
    const body = rejectSchema.parse(await c.req.json());
    const current = store.get(suggestionId(c.req.param("id")));
    const next = store.transition(current.id, { type: "reject", reason: body.reason }, now(), profile(current.profileId));
    notify();
    return c.json(itemView(next));
  });
  app.post("/api/items/:id/reschedule", async (c) => {
    const body = rescheduleSchema.parse(await c.req.json());
    const current = store.get(suggestionId(c.req.param("id")));
    if (current.status !== "suggestion" && current.status !== "approved") {
      return c.json(
        { error: "A signed event is frozen. Discard it and sign again to choose a new time." },
        409,
      );
    }
    const next = store.transition(
      current.id,
      { type: "edit", draft: parseDraft(shiftDraft(current, body.fireAt)) },
      now(),
      profile(current.profileId),
    );
    notify();
    return c.json(itemView(next));
  });
  app.post("/api/items/:id/discard", async (c) => {
    const body = discardSchema.parse(await c.req.json());
    const current = store.get(suggestionId(c.req.param("id")));
    const next = store.transition(current.id, { type: "discard", reason: body.reason }, now(), profile(current.profileId));
    notify();
    return c.json(itemView(next));
  });
  app.post("/api/context", async (c) => {
    const body = contextSchema.parse(await c.req.json());
    const owner = profile(body.profileId);
    const context = await contextFor({ profiles: profiles(), store, now }, owner, body.ref);
    return c.json({ context });
  });
  app.post("/api/sign/nip07/next", async (c) => {
    const body = signNextSchema.parse(await c.req.json());
    const owner = profile(body.profileId);
    let cursor = cursors.get(owner.id);
    if (!cursor || cursor.profileId !== owner.id) cursor = blankCursor(owner.id);
    if (cursor.current) {
      cursors.set(owner.id, cursor);
      return c.json({ done: false, itemId: cursor.current.itemId, unsigned: cursor.current.unsigned });
    }
    for (const item of store.list(owner.id)) {
      if (item.status !== "approved") continue;
      const signedSoFar = cursor.pending.get(item.id) ?? [];
      const unsigned = nextUnsigned({ item, profile: owner, signedSoFar, now: now() });
      if (!unsigned) continue;
      cursor.current = { itemId: item.id, unsigned };
      cursors.set(owner.id, cursor);
      return c.json({ done: false, itemId: item.id, unsigned });
    }
    cursors.set(owner.id, cursor);
    return c.json({ done: true });
  });
  app.post("/api/sign/nip07/submit", async (c) => {
    const body = signSubmitSchema.parse(await c.req.json());
    const current = store.get(suggestionId(body.itemId));
    if (current.status !== "approved") throw new Error("only an approved item can be signed");
    const owner = profile(current.profileId);
    const cursor = cursors.get(owner.id) ?? blankCursor(owner.id);
    if (!cursor.current || cursor.current.itemId !== current.id) throw new Error("that event is not waiting for a signature");
    const signed = acceptSigned(cursor.current.unsigned, body.event, owner.pubkey);
    const signedSoFar = [...(cursor.pending.get(current.id) ?? []), signed];
    const more = nextUnsigned({ item: current, profile: owner, signedSoFar, now: now() });
    if (more) {
      cursor.pending.set(current.id, signedSoFar);
      cursor.current = { itemId: current.id, unsigned: more };
      cursors.set(owner.id, cursor);
      notify();
      return c.json({ done: false, itemId: current.id, unsigned: more });
    }
    const [first, ...rest] = signedSoFar;
    if (!first) throw new Error("nothing was signed");
    store.transition(current.id, { type: "sign", events: [first, ...rest] }, now());
    const queued = store.transition(current.id, { type: "enqueue" }, now());
    cursor.pending.delete(current.id);
    cursor.current = null;
    cursors.set(owner.id, cursor);
    notify();
    return c.json({ done: true, item: itemView(queued) });
  });
  app.post("/api/sign/nip46", async (c) => {
    const body = profileActionSchema.parse(await c.req.json());
    const owner = profile(body.profileId);
    if (owner.signer.kind !== "nip46") throw new Error("pair a bunker before signing this way");
    const signer = await connectBunker({
      bunkerUri: owner.signer.bunkerUri,
      userPubkey: owner.pubkey,
      sessionDir: join(options.dataDir, "nip46"),
      now,
      session: sessionOptions,
    });
    const signed = [];
    for (const item of store.list(owner.id)) {
      if (item.status !== "approved") continue;
      const { signApproved } = await import("../signers/batch.ts");
      const work = await signApproved({
        signer,
        item,
        now: now(),
        maxAheadSeconds: signAheadSeconds(),
        relayHint: owner.relays.configured[0],
      });
      store.transition(item.id, { type: "sign", events: [...work.events] }, now());
      signed.push(store.transition(item.id, { type: "enqueue" }, now()));
    }
    notify();
    return c.json({ status: "signed", count: signed.length, items: signed.map(itemView) });
  });
  app.get("/api/nip46", (c) => {
    const id = c.req.query("profileId");
    if (!id) return c.json({ error: "profileId is required" }, 400);
    const owner = profile(id);
    const session = loadOrCreateSession(join(options.dataDir, "nip46"), sessionOptions);
    const relay = owner.relays.configured[0];
    const connectUri = `nostrconnect://${session.pubkey}?relay=${encodeURIComponent(relay)}&perms=sign_event:1&name=nostr-scheduler`;
    const shown = publicSigner(owner);
    return c.json({
      paired: owner.signer.kind === "nip46",
      bunkerUri: shown.signer.kind === "nip46" ? shown.signer.bunkerUri : "",
      connectUri,
      request: "idle",
    });
  });
  app.post("/api/nip46/pair", async (c) => {
    const body = bunkerSchema.parse(await c.req.json());
    const owner = profile(body.profileId);
    await connectBunker({
      bunkerUri: body.bunkerUri,
      userPubkey: owner.pubkey,
      sessionDir: join(options.dataDir, "nip46"),
      now,
      session: sessionOptions,
    });
    setProfileSigner(profilesPath, owner.id, { kind: "nip46", bunker_uri: body.bunkerUri });
    notify();
    return c.json({ paired: true, request: "paired" });
  });
  app.post("/api/nip46/disconnect", async (c) => {
    const body = profileActionSchema.parse(await c.req.json());
    const owner = profile(body.profileId);
    wipeSession(join(options.dataDir, "nip46"), sessionOptions);
    if (owner.signer.kind === "nip46") setProfileSigner(profilesPath, owner.id, { kind: "nip07" });
    notify();
    return c.json({ paired: false, request: "disconnected" });
  });
  app.post("/api/publish", async (c) => {
    const summary = await publishDue({
      store,
      profiles: profiles(),
      transport: { publish: publishToRelay },
      now,
      windowSeconds: Number(process.env.NOSTR_SCHEDULER_CATCH_UP_SECONDS ?? 15 * 60),
    });
    notify();
    return c.json(summary);
  });
  app.get("/api/log", (c) => {
    const rows = store
      .list()
      .filter((item) => item.status === "sent" || item.status === "failed")
      .map(itemView);
    return c.json(rows);
  });

  if (options.staticDir && existsSync(options.staticDir)) {
    app.use("/*", serveStatic({ root: options.staticDir }));
    app.get("*", serveStatic({ path: join(options.staticDir, "index.html") }));
  }
  return { app, store, close: () => store.close(), notify };
}
