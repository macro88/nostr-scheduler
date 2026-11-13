import { join } from "node:path";
import { WebSocket } from "ws";
import type { Context, Hono } from "hono";
import { InputError } from "../domain/brand.ts";
import { containsPrivateKey, assertValueHasNoPrivateKey } from "../domain/private-key.ts";
import { classifyPublishRelay, isLoopbackRelay } from "../domain/relays.ts";
import { criteriaLocation } from "../profiles/criteria.ts";
import { createProfileRecord, deleteProfileRecord, updateProfileRecord } from "../profiles/record.ts";
import type { Profile, UnixSeconds } from "../domain/types.ts";
import type { WorkStore } from "../work/store.ts";
import { profileJson } from "./profile-view.ts";

type Deps = {
  dataDir: string;
  profilesPath: string;
  profile: (id: string) => Profile;
  store: WorkStore;
  now: () => UnixSeconds;
  notify: () => void;
};

async function readJson(c: Context): Promise<unknown> {
  const raw = await c.req.text();
  if (containsPrivateKey(raw)) assertValueHasNoPrivateKey(raw);
  let parsed: unknown;
  try {
    parsed = raw === "" ? {} : JSON.parse(raw);
  } catch {
    throw new InputError("body", "expected JSON");
  }
  assertValueHasNoPrivateKey(parsed);
  return parsed;
}

function queuedOrSigned(store: WorkStore, profile: Profile): number {
  return store.list(profile.id).filter((item) => item.status === "queued" || item.status === "signed").length;
}

function probeLoopback(url: string): Promise<boolean> {
  const decision = classifyPublishRelay(url, false);
  if (!isLoopbackRelay(decision.url) || decision.public) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = new WebSocket(decision.url);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.close();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 400);
    socket.once("open", () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

export function mountProfileRoutes(app: Hono, deps: Deps): void {
  app.get("/api/criteria-path", (c) => {
    const path = c.req.query("path") ?? "";
    if (containsPrivateKey(path)) assertValueHasNoPrivateKey(path);
    const located = criteriaLocation(deps.dataDir, path);
    return c.json({ path: located.relativePath, exists: located.exists });
  });

  app.post("/api/profiles/relay-probe", async (c) => {
    const body = await readJson(c);
    const url = typeof body === "object" && body !== null && "url" in body && typeof body.url === "string" ? body.url : "";
    if (!url) throw new InputError("relay", "Relay addresses start with ws:// or wss://.");
    const decision = classifyPublishRelay(url, false);
    if (!isLoopbackRelay(decision.url)) return c.json({ reachable: false, probed: false });
    const reachable = await probeLoopback(url);
    return c.json({ reachable, probed: true });
  });

  app.post("/api/profiles", async (c) => {
    const body = await readJson(c);
    const id = createProfileRecord(deps.profilesPath, deps.dataDir, body);
    deps.notify();
    const created = deps.profile(id);
    return c.json(profileJson(created, deps.dataDir, 0), 201);
  });

  app.patch("/api/profiles/:id", async (c) => {
    const id = c.req.param("id");
    deps.profile(id);
    const body = await readJson(c);
    updateProfileRecord(deps.profilesPath, deps.dataDir, id, body);
    deps.notify();
    const next = deps.profile(id);
    return c.json(profileJson(next, deps.dataDir, queuedOrSigned(deps.store, next)));
  });

  app.delete("/api/profiles/:id", (c) => {
    const owner = deps.profile(c.req.param("id"));
    const affected = deps.store.list(owner.id).filter((item) => item.status === "queued" || item.status === "signed");
    for (const item of affected) {
      deps.store.transition(item.id, { type: "discard", reason: "profile removed" }, deps.now());
    }
    deleteProfileRecord(deps.profilesPath, owner.id);
    deps.notify();
    return c.json({ removed: true, discarded: affected.length });
  });
}

export function profilesPathFor(dataDir: string): string {
  return join(dataDir, "profiles.yaml");
}
