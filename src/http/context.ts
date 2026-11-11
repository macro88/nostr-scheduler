import { nip19 } from "nostr-tools";
import { eventId, hexPubkey, relayUrl } from "../domain/brand.ts";
import type { Profile, ReplyTarget } from "../domain/types.ts";
import { readThreadContext, type McpContext } from "../mcp/server.ts";

export function parseNoteRef(ref: string): { id: string; pubkey?: string; relays: string[] } {
  const trimmed = ref.trim();
  if (/^[0-9a-f]{64}$/.test(trimmed)) return { id: trimmed, relays: [] };
  let decoded: ReturnType<typeof nip19.decode>;
  try {
    decoded = nip19.decode(trimmed);
  } catch {
    throw new Error("paste a note id or nevent");
  }
  if (decoded.type === "note") return { id: decoded.data, relays: [] };
  if (decoded.type === "nevent") {
    return { id: decoded.data.id, pubkey: decoded.data.author, relays: [...(decoded.data.relays ?? [])] };
  }
  throw new Error("paste a note id or nevent");
}

export async function contextFor(ctx: McpContext, profile: Profile, ref: string): Promise<string> {
  const parsed = parseNoteRef(ref);
  const target: ReplyTarget = {
    eventId: eventId(parsed.id),
    rootId: eventId(parsed.id),
    pubkey: hexPubkey(parsed.pubkey ?? profile.pubkey),
  };
  const hint = parsed.relays[0];
  if (hint) {
    try {
      return await readThreadContext(ctx, profile, { ...target, relayHint: relayUrl(hint) });
    } catch {
      return readThreadContext(ctx, profile, target);
    }
  }
  return readThreadContext(ctx, profile, target);
}
