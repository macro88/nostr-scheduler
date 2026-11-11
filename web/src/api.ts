import type { Unsigned } from "./nostr";

export type Profile = {
  id: string;
  label: string;
  pubkey: string;
  signer: { kind: string; bunkerUri?: string; bindHost?: string; platform?: string };
};

export type Item = {
  id: string;
  profileId: string;
  status: string;
  fireAt: number[];
  preview: string;
  rationale?: string;
  reason?: string;
  draft?: {
    type: string;
    content?: string;
    proposedFireAt?: number;
    segments?: { content: string; proposedFireAt: number }[];
    parent?: { at: number; content: string };
  };
  events?: { id: string; content: string; created_at: number; tags: string[][] }[];
  results?: { relay: string; accepted: boolean; message: string }[];
  lateBySeconds?: number;
};

export type Nip46Info = {
  paired: boolean;
  bunkerUri: string;
  connectUri: string;
  request: string;
};

let token = "";

async function ensureToken(): Promise<void> {
  if (token) return;
  const response = await fetch("/api/session");
  const body = (await response.json()) as { token: string };
  token = body.token;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  await ensureToken();
  const headers = new Headers(init.headers);
  headers.set("x-csrf-token", token);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "request failed");
  return body;
}

export function resetToken(): void {
  token = "";
}

export async function signWithBrowser(profileId: string, onStep?: (index: number) => void, itemIds?: string[]): Promise<number> {
  if (!window.nostr) throw new Error("no browser signer");
  let count = 0;
  let step = 0;
  for (let guard = 0; guard < 40; guard += 1) {
    const next = await api<{ done: boolean; itemId?: string; unsigned?: Unsigned }>("/api/sign/nip07/next", {
      method: "POST",
      body: JSON.stringify({ profileId, ...(itemIds ? { itemIds } : {}) }),
    });
    if (next.done || !next.unsigned || !next.itemId) return count;
    step += 1;
    onStep?.(step);
    const signed = await window.nostr.signEvent(next.unsigned);
    const saved = await api<{ done: boolean }>("/api/sign/nip07/submit", {
      method: "POST",
      body: JSON.stringify({ itemId: next.itemId, event: signed }),
    });
    if (saved.done) count += 1;
  }
  return count;
}
