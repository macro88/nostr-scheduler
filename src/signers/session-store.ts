import { Entry } from "@napi-rs/keyring";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { resolve } from "node:path";

const SERVICE = "nostr-scheduler";

export type SessionStore = {
  read(): string | null;
  write(value: string): void;
  delete(): void;
};

export function sessionAccount(dir: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(resolve(dir)))).slice(0, 32);
}

export function memorySessionStore(): SessionStore {
  let value: string | null = null;
  return {
    read() {
      return value;
    },
    write(next) {
      value = next;
    },
    delete() {
      value = null;
    },
  };
}

export function keyringSessionStore(account: string): SessionStore {
  const entry = new Entry(SERVICE, account, { linux: { store: "secret-service" } });
  return {
    read() {
      return entry.getPassword();
    },
    write(value) {
      entry.setPassword(value);
    },
    delete() {
      entry.deletePassword();
    },
  };
}

export function openKeychainStore(dir: string): SessionStore | null {
  try {
    return keyringSessionStore(sessionAccount(dir));
  } catch {
    return null;
  }
}
