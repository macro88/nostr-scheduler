import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { WebSocket, type RawData } from "ws";
import { hexPubkey, unixSeconds, type HexPubkey, type RelayUrl } from "../domain/brand.ts";
import { npubFromPubkey } from "../domain/bech32.ts";
import { canonicalId, parseRawEvent, parseSignedEvent } from "../domain/event.ts";
import { runtimeMode } from "../mode.ts";
import type { Npub, SignedEvent, Signer, UnsignedEvent } from "../domain/types.ts";
import { createSession, decryptPayload, encryptPayload, signKind24133 } from "../signers/nip46-session.ts";

export function createMockSigner(env: NodeJS.ProcessEnv = process.env): Signer & { npub: Npub } {
  if (runtimeMode(env) === "production") {
    throw new Error("mock signer is available only in test or demo mode");
  }
  const secretKey = schnorr.utils.randomSecretKey();
  const pubkey = hexPubkey(bytesToHex(schnorr.getPublicKey(secretKey)));
  return {
    ref: { kind: "mock" },
    pubkey,
    npub: npubFromPubkey(pubkey),
    async signEvent(event: UnsignedEvent): Promise<SignedEvent> {
      if (runtimeMode(env) === "production") {
        throw new Error("mock signer is available only in test or demo mode");
      }
      if (event.pubkey !== pubkey) throw new Error("event pubkey does not match the mock signer");
      if (event.kind !== 1) throw new Error("mock signer only signs kind 1");
      const id = canonicalId(event);
      const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey));
      return parseSignedEvent({ ...event, id, sig });
    },
  };
}

function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

export async function startMockBunker(
  relay: RelayUrl,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ uri: string; pubkey: HexPubkey; permissions: string[]; close: () => void }> {
  const user = createMockSigner(env);
  const bunker = createSession();
  const connection = "demo-connection";
  const permissions: string[] = [];
  const uri = `bunker://${bunker.pubkey}?relay=${encodeURIComponent(relay)}&secret=${connection}`;
  const ws = new WebSocket(relay);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", () => reject(new Error("mock bunker failed to connect")));
  });
  ws.send(JSON.stringify(["REQ", "bunker", { kinds: [24133], "#p": [bunker.pubkey] }]));
  ws.on("message", (data) => {
    void (async () => {
      let message: unknown;
      try {
        message = JSON.parse(textOf(data));
      } catch {
        return;
      }
      if (!Array.isArray(message) || message[0] !== "EVENT") return;
      const raw = parseRawEvent(message[2]);
      if (raw.kind !== 24133) return;
      const body = JSON.parse(decryptPayload(raw.content, bunker.secretKey, raw.pubkey)) as {
        id?: string;
        method?: string;
        params?: string[];
      };
      const params = body.params ?? [];
      let result = "";
      if (body.method === "connect") {
        const provided = params[1] ?? "";
        const perms = params[2] ?? "";
        permissions.push(perms);
        if (provided !== connection || perms !== "sign_event:1" || /encrypt|decrypt/.test(perms)) return;
        result = "ack";
      } else if (body.method === "get_public_key") {
        result = user.pubkey;
      } else if (body.method === "sign_event") {
        const unsigned = JSON.parse(params[0] ?? "{}") as UnsignedEvent;
        result = JSON.stringify(await user.signEvent({ ...unsigned, pubkey: user.pubkey }));
      } else {
        return;
      }
      const content = encryptPayload(JSON.stringify({ id: body.id, result }), bunker.secretKey, raw.pubkey);
      const response = signKind24133({
        session: bunker,
        remotePubkey: raw.pubkey,
        content,
        createdAt: unixSeconds(Math.floor(Date.now() / 1000)),
      });
      ws.send(JSON.stringify(["EVENT", response]));
    })();
  });
  return {
    uri,
    pubkey: user.pubkey,
    permissions,
    close() {
      ws.close();
    },
  };
}
