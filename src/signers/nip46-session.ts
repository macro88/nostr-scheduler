import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chacha20 } from "@noble/ciphers/chacha.js";
import { equalBytes } from "@noble/ciphers/utils.js";
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { expand as hkdfExpand, extract as hkdfExtract } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";
import { WebSocket, type RawData } from "ws";
import { hexPubkey, type HexPubkey, type UnixSeconds } from "../domain/brand.ts";
import { canonicalId, parseRawEvent } from "../domain/event.ts";
import { assertRelayAllowed } from "../domain/relays.ts";
import type { EventTag, RelayUrl } from "../domain/types.ts";
import { openKeychainStore, type SessionStore } from "./session-store.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type Session = {
  readonly secretKey: Uint8Array;
  readonly pubkey: HexPubkey;
};

function conversationKey(secretKey: Uint8Array, remotePubkey: HexPubkey): Uint8Array {
  const shared = secp256k1.getSharedSecret(secretKey, hexToBytes(`02${remotePubkey}`)).subarray(1, 33);
  return hkdfExtract(sha256, shared, textEncoder.encode("nip44-v2"));
}

function messageKeys(key: Uint8Array, nonce: Uint8Array): { chachaKey: Uint8Array; chachaNonce: Uint8Array; hmacKey: Uint8Array } {
  const keys = hkdfExpand(sha256, key, nonce, 76);
  return { chachaKey: keys.subarray(0, 32), chachaNonce: keys.subarray(32, 44), hmacKey: keys.subarray(44, 76) };
}

function calcPaddedLen(len: number): number {
  if (len <= 32) return 32;
  const nextPower = 2 ** (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

function pad(plaintext: string): Uint8Array {
  const unpadded = textEncoder.encode(plaintext);
  const prefix = new Uint8Array(2);
  new DataView(prefix.buffer).setUint16(0, unpadded.length, false);
  const suffix = new Uint8Array(calcPaddedLen(unpadded.length) - unpadded.length);
  return concatBytes(prefix, unpadded, suffix);
}

function unpad(padded: Uint8Array): string {
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint16(0, false);
  const unpadded = padded.subarray(2, 2 + length);
  if (length < 1 || unpadded.length !== length || padded.length !== 2 + calcPaddedLen(length)) {
    throw new Error("invalid padding");
  }
  return textDecoder.decode(unpadded);
}

export function encryptPayload(plaintext: string, secretKey: Uint8Array, remotePubkey: HexPubkey, nonce = randomBytes(32)): string {
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversationKey(secretKey, remotePubkey), nonce);
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(plaintext));
  const mac = hmac(sha256, hmacKey, concatBytes(nonce, ciphertext));
  return base64.encode(concatBytes(new Uint8Array([2]), nonce, ciphertext, mac));
}

export function decryptPayload(payload: string, secretKey: Uint8Array, remotePubkey: HexPubkey): string {
  if (payload.length < 132 || payload.startsWith("#")) throw new Error("unsupported payload");
  const data = base64.decode(payload);
  if (data.length < 99 || data[0] !== 2) throw new Error("unsupported payload");
  const nonce = data.subarray(1, 33);
  const mac = data.subarray(-32);
  const ciphertext = data.subarray(33, -32);
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversationKey(secretKey, remotePubkey), nonce);
  const calculated = hmac(sha256, hmacKey, concatBytes(nonce, ciphertext));
  if (!equalBytes(calculated, mac)) throw new Error("invalid payload mac");
  return unpad(chacha20(chachaKey, chachaNonce, ciphertext));
}

export function nip44SelfCheck(): void {
  const sec1 = hexToBytes("0000000000000000000000000000000000000000000000000000000000000001");
  const sec2 = hexToBytes("0000000000000000000000000000000000000000000000000000000000000002");
  const pub2 = bytesToHex(schnorr.getPublicKey(sec2));
  const nonce = hexToBytes("0000000000000000000000000000000000000000000000000000000000000001");
  const payload = encryptPayload("a", sec1, hexPubkey(pub2), nonce);
  const expected =
    "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb";
  if (payload !== expected) throw new Error("conversation payload does not match the published vector");
  const pub1 = bytesToHex(schnorr.getPublicKey(sec1));
  if (decryptPayload(payload, sec2, hexPubkey(pub1)) !== "a") throw new Error("conversation payload did not decrypt");
}

export function createSession(): Session {
  const secretKey = schnorr.utils.randomSecretKey();
  return { secretKey, pubkey: hexPubkey(bytesToHex(schnorr.getPublicKey(secretKey))) };
}

export function fileSessionWarning(path: string): string {
  return `warning: session key stored in ${path} with mode 0600. Anyone who can read this file can ask the bunker for signatures. Prefer the OS keychain.`;
}

export type SessionLoadOptions = {
  store?: SessionStore;
  allowFile?: boolean;
  keychain?: (dir: string) => SessionStore | null;
  warn?: (message: string) => void;
};

function legacyPath(dir: string): string {
  return join(dir, "client.json");
}

function readLegacyHex(dir: string): string | null {
  let raw: string | null = null;
  try {
    raw = readFileSync(legacyPath(dir), "utf8");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    return null;
  }
  const parsed = JSON.parse(raw) as { secretKey?: string };
  if (!parsed.secretKey || !/^[0-9a-f]{64}$/.test(parsed.secretKey)) throw new Error("bad session file");
  return parsed.secretKey;
}

function writeLegacyHex(dir: string, hex: string): void {
  const path = legacyPath(dir);
  writeFileSync(path, JSON.stringify({ secretKey: hex }), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function fileSessionStore(dir: string): SessionStore {
  return {
    read() {
      return readLegacyHex(dir);
    },
    write(value) {
      writeLegacyHex(dir, value);
    },
    delete() {
      rmSync(legacyPath(dir), { force: true });
    },
  };
}

function sessionFromHex(hex: string): Session {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("stored session is unreadable");
  const secretKey = hexToBytes(hex);
  return { secretKey, pubkey: hexPubkey(bytesToHex(schnorr.getPublicKey(secretKey))) };
}

export function writeLegacySessionFile(dir: string, session: Session): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeLegacyHex(dir, bytesToHex(session.secretKey));
  return legacyPath(dir);
}

function chooseStore(dir: string, options: SessionLoadOptions): { store: SessionStore; usingFile: boolean } {
  if (options.store) return { store: options.store, usingFile: false };
  const allowFile = options.allowFile === true || process.env.NOSTR_SCHEDULER_ALLOW_FILE_SESSION === "1";
  const opened = (options.keychain ?? openKeychainStore)(resolve(dir));
  if (opened) return { store: opened, usingFile: false };
  if (allowFile) return { store: fileSessionStore(dir), usingFile: true };
  throw new Error(
    "no keychain is available. Pass --allow-file-session or set NOSTR_SCHEDULER_ALLOW_FILE_SESSION=1 to store the session key in a mode 0600 file.",
  );
}

export function loadOrCreateSession(dir: string, options: SessionLoadOptions = {}): Session {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { store, usingFile } = chooseStore(dir, options);
  if (usingFile) (options.warn ?? ((message) => console.error(message)))(fileSessionWarning(legacyPath(dir)));
  const legacy = readLegacyHex(dir);
  if (legacy && !usingFile) {
    if (!store.read()) store.write(legacy);
    rmSync(legacyPath(dir), { force: true });
  }
  const existing = store.read();
  if (existing) return sessionFromHex(existing);
  const created = createSession();
  store.write(bytesToHex(created.secretKey));
  return created;
}

export function wipeSession(dir: string, options: SessionLoadOptions = {}): void {
  const store = options.store ?? (options.keychain ?? openKeychainStore)(resolve(dir));
  try {
    store?.delete();
  } catch {
    // A missing keychain still leaves the file to remove.
  }
  rmSync(legacyPath(dir), { force: true });
}

export function signKind24133(args: {
  session: Session;
  remotePubkey: HexPubkey;
  content: string;
  createdAt: UnixSeconds;
}): { id: string; pubkey: string; created_at: number; kind: 24133; tags: EventTag[]; content: string; sig: string } {
  const tag: EventTag = ["p", args.remotePubkey];
  const event = {
    pubkey: args.session.pubkey,
    created_at: args.createdAt,
    kind: 24133 as const,
    tags: [tag],
    content: args.content,
  };
  const id = canonicalId(event);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), args.session.secretKey));
  return { ...event, id, sig };
}

function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

export async function bunkerRequest(args: {
  session: Session;
  bunkerPubkey: HexPubkey;
  relays: readonly RelayUrl[];
  method: string;
  params: readonly string[];
  createdAt: UnixSeconds;
  timeoutMs?: number;
}): Promise<string> {
  const relay = args.relays[0];
  if (!relay) throw new Error("bunker URI has no relay");
  assertRelayAllowed(relay);
  const requestId = bytesToHex(randomBytes(8));
  const plaintext = JSON.stringify({ id: requestId, method: args.method, params: args.params });
  const content = encryptPayload(plaintext, args.session.secretKey, args.bunkerPubkey);
  const event = signKind24133({ session: args.session, remotePubkey: args.bunkerPubkey, content, createdAt: args.createdAt });
  parseRawEvent(event);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relay);
    let settled = false;
    let sent = false;
    const finish = (error: Error | null, result?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else resolve(result ?? "");
    };
    const timer = setTimeout(() => finish(new Error("bunker timed out")), args.timeoutMs ?? 4000);
    ws.on("error", () => finish(new Error("bunker connection failed")));
    ws.on("open", () => {
      ws.send(JSON.stringify(["REQ", "bunker", { kinds: [24133], authors: [args.bunkerPubkey], "#p": [args.session.pubkey] }]));
    });
    ws.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(textOf(data));
      } catch {
        return;
      }
      if (Array.isArray(message) && message[0] === "EOSE" && !sent) {
        sent = true;
        ws.send(JSON.stringify(["EVENT", event]));
        return;
      }
      if (!Array.isArray(message) || message[0] !== "EVENT") return;
      try {
        const raw = parseRawEvent(message[2]);
        if (raw.kind !== 24133 || raw.pubkey !== args.bunkerPubkey) return;
        const body = JSON.parse(decryptPayload(raw.content, args.session.secretKey, args.bunkerPubkey)) as {
          id?: string;
          result?: string;
          error?: string;
        };
        if (body.id !== requestId) return;
        if (body.error) {
          finish(new Error(body.error));
          return;
        }
        finish(null, String(body.result ?? ""));
      } catch {
        return;
      }
    });
  });
}
