import { hexPubkey, type HexPubkey, type RelayUrl, type UnixSeconds } from "../domain/brand.ts";
import { assertSamePayload, parseSignedEvent } from "../domain/event.ts";
import type { SignedEvent, Signer, UnsignedEvent } from "../domain/types.ts";
import { bunkerRequest, loadOrCreateSession, type Session, type SessionLoadOptions } from "./nip46-session.ts";

export const SIGN_EVENT_PERMISSION = "sign_event:1";

export function connectParams(secret: string | null): readonly [string, string, string] {
  return ["", secret ?? "", SIGN_EVENT_PERMISSION];
}

export type BunkerParts = {
  readonly pubkey: HexPubkey;
  readonly relays: readonly RelayUrl[];
  readonly secret: string | null;
};

export function parseBunkerUri(uri: string): BunkerParts {
  if (!uri.startsWith("bunker://")) throw new Error("bunker URI must start with bunker://");
  const rest = uri.slice("bunker://".length);
  const splitAt = rest.indexOf("?");
  const pubkeyPart = (splitAt === -1 ? rest : rest.slice(0, splitAt)).replace(/\/$/, "");
  const params = new URLSearchParams(splitAt === -1 ? "" : rest.slice(splitAt + 1));
  const relays = params.getAll("relay").map((value) => value as RelayUrl);
  if (relays.length === 0) throw new Error("bunker URI needs a relay");
  return {
    pubkey: hexPubkey(pubkeyPart),
    relays,
    secret: params.get("secret"),
  };
}

export type Nip46Caller = (method: string, params: readonly string[]) => Promise<string>;

export function createNip46Signer(args: {
  userPubkey: HexPubkey;
  call: Nip46Caller;
}): Signer {
  return {
    ref: { kind: "nip46", bunkerUri: "bunker://configured" },
    pubkey: args.userPubkey,
    async signEvent(event: UnsignedEvent): Promise<SignedEvent> {
      const result = await args.call("sign_event", [JSON.stringify(event)]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(result);
      } catch {
        throw new Error("bunker returned a result that is not JSON");
      }
      const signed = parseSignedEvent(parsed);
      assertSamePayload(event, signed);
      if (signed.pubkey !== args.userPubkey) throw new Error("bunker signed with a different pubkey");
      return signed;
    },
  };
}

export async function connectBunker(args: {
  bunkerUri: string;
  userPubkey: HexPubkey;
  sessionDir: string;
  now: () => UnixSeconds;
  session?: SessionLoadOptions;
}): Promise<Signer> {
  const parts = parseBunkerUri(args.bunkerUri);
  const session: Session = loadOrCreateSession(args.sessionDir, args.session);
  const call: Nip46Caller = (method, params) =>
    bunkerRequest({
      session,
      bunkerPubkey: parts.pubkey,
      relays: parts.relays,
      method,
      params,
      createdAt: args.now(),
    });
  const ack = await call("connect", connectParams(parts.secret));
  if (ack !== "ack") throw new Error("bunker did not acknowledge the connection");
  const pubkey = await call("get_public_key", []);
  if (pubkey !== args.userPubkey) throw new Error("bunker pubkey does not match the profile");
  return createNip46Signer({ userPubkey: args.userPubkey, call });
}
