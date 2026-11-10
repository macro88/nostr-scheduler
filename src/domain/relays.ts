import { runtimeMode } from "../mode.ts";
import { relayUrl, type RelayUrl } from "./brand.ts";
import type { EventTag } from "./types.ts";

export function isLoopbackRelay(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "ws:" || url.protocol === "wss:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1")
    );
  } catch {
    return false;
  }
}

export function assertRelayAllowed(url: RelayUrl, env: NodeJS.ProcessEnv = process.env): void {
  const mode = runtimeMode(env);
  if ((mode === "test" || mode === "demo") && !isLoopbackRelay(url)) {
    throw new Error("test and demo modes only connect to a loopback relay");
  }
}

export type RelayList = {
  readonly read: readonly RelayUrl[];
  readonly write: readonly RelayUrl[];
};

export function relayListFromTags(tags: readonly EventTag[]): RelayList {
  const read: RelayUrl[] = [];
  const write: RelayUrl[] = [];
  for (const tag of tags) {
    if (tag[0] !== "r" || tag[1] === undefined) continue;
    let url: RelayUrl;
    try {
      url = relayUrl(tag[1]);
    } catch {
      continue;
    }
    const marker = tag[2];
    if (marker === "read") read.push(url);
    else if (marker === "write") write.push(url);
    else {
      read.push(url);
      write.push(url);
    }
  }
  return { read, write };
}

export function mergeWriteRelays(
  configured: readonly RelayUrl[],
  list: RelayList,
  readNip65: boolean,
): RelayUrl[] {
  if (!readNip65) return [...configured];
  const merged = [...configured];
  for (const url of list.write) {
    if (!merged.includes(url)) merged.push(url);
  }
  return merged;
}
