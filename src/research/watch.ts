import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pubkeyFromNpub } from "../domain/bech32.ts";
import { InputError, npub, type HexPubkey, type ProfileId } from "../domain/brand.ts";

export function watchListPath(dataDir: string, id: ProfileId): string {
  return join(dataDir, "watch", `${id}.txt`);
}

export function parseWatchList(text: string): HexPubkey[] {
  const found: HexPubkey[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim() ?? "";
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    try {
      const value = npub(trimmed);
      const pubkey = pubkeyFromNpub(value);
      if (seen.has(pubkey)) continue;
      seen.add(pubkey);
      found.push(pubkey);
    } catch {
      throw new InputError("npub", `line ${index + 1} is not an npub`);
    }
  }
  return found;
}

export function loadWatchAuthors(dataDir: string, id: ProfileId): HexPubkey[] | null {
  const path = watchListPath(dataDir, id);
  if (!existsSync(path)) return null;
  return parseWatchList(readFileSync(path, "utf8"));
}
