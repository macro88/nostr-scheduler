import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { pubkeyFromNpub } from "../domain/bech32.ts";
import {
  hexPubkey,
  InputError,
  npub,
  profileId,
  suggesterId,
  type ProfileId,
} from "../domain/brand.ts";
import { DEFAULT_READ_NIP65 } from "../domain/defaults.ts";
import { classifyPublishRelay } from "../domain/relays.ts";
import type { Profile, SignerRef } from "../domain/types.ts";
import { criteriaLocation } from "./criteria.ts";
import { runtimeMode, type RuntimeMode } from "../mode.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function signerOf(value: unknown, mode: RuntimeMode): SignerRef {
  if (!isRecord(value) || typeof value.kind !== "string") throw new InputError("signer", "expected a kind");
  if (value.kind === "nip07") return { kind: "nip07", bindHost: "127.0.0.1" };
  if (value.kind === "nip46") {
    if (value.bunker_uri === undefined || value.bunker_uri === "") return { kind: "nip46", bunkerUri: "" };
    if (typeof value.bunker_uri !== "string" || !value.bunker_uri.startsWith("bunker://")) {
      throw new InputError("bunker_uri", "expected a bunker URI");
    }
    return { kind: "nip46", bunkerUri: value.bunker_uri };
  }
  if (value.kind === "nip55") return { kind: "nip55", platform: "android" };
  if (value.kind === "mock") {
    if (mode === "production") throw new InputError("signer", "mock signer is available only in test or demo mode");
    return { kind: "mock" };
  }
  throw new InputError("signer", "expected nip07, nip46, nip55, or mock");
}

function profileOf(value: unknown, dir: string, mode: RuntimeMode): Profile {
  if (!isRecord(value)) throw new InputError("profiles", "expected a mapping");
  if (typeof value.id !== "string") throw new InputError("id", "expected a string");
  if (typeof value.label !== "string" || value.label.trim() === "") throw new InputError("label", "expected a string");
  if (typeof value.npub !== "string") throw new InputError("npub", "expected a string");
  if (typeof value.pubkey !== "string") throw new InputError("pubkey", "expected a string");
  if (typeof value.suggester_id !== "string") throw new InputError("suggester_id", "expected a string");
  if (typeof value.criteria_path !== "string") throw new InputError("criteria_path", "expected a string");
  const pubkey = hexPubkey(value.pubkey);
  const encoded = npub(value.npub);
  if (pubkeyFromNpub(encoded) !== pubkey) throw new InputError("npub", "does not match pubkey");
  if (!Array.isArray(value.relays)) throw new InputError("relays", "expected a list of URLs");
  const allowPublicRelays = value.allow_public_relays === true;
  if (value.allow_public_relays !== undefined && typeof value.allow_public_relays !== "boolean") {
    throw new InputError("allow_public_relays", "expected a boolean");
  }
  const listed = value.relays.map((item) => {
    const url = typeof item === "string" ? item : isRecord(item) && typeof item.url === "string" ? item.url : "";
    if (!url) throw new InputError("relay", "Relay addresses start with ws:// or wss://.");
    return classifyPublishRelay(url, allowPublicRelays);
  });
  const readNip65 = value.read_nip65 === undefined ? DEFAULT_READ_NIP65 : value.read_nip65 === true;
  if (value.read_nip65 !== undefined && typeof value.read_nip65 !== "boolean") {
    throw new InputError("read_nip65", "expected a boolean");
  }
  const criteria = criteriaLocation(dir, value.criteria_path);
  return {
    id: profileId(value.id),
    label: value.label,
    npub: encoded,
    pubkey,
    suggesterId: suggesterId(value.suggester_id),
    signer: signerOf(value.signer, mode),
    relays: {
      configured: listed.filter((item) => item.publish).map((item) => item.url),
      listed,
      readNip65,
      allowPublicRelays,
    },
    criteriaPath: criteria.absolutePath,
  };
}

export function loadProfiles(path: string, env: NodeJS.ProcessEnv = process.env): Profile[] {
  const raw = parse(readFileSync(path, "utf8"));
  if (!isRecord(raw) || !Array.isArray(raw.profiles)) throw new InputError("profiles", "expected a list");
  const dir = resolve(path, "..");
  const mode = runtimeMode(env);
  const profiles = raw.profiles.map((item) => profileOf(item, dir, mode));
  const ids = new Set<ProfileId>();
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new InputError("id", `duplicate profile ${profile.id}`);
    ids.add(profile.id);
  }
  return profiles;
}

export function maskedBunkerUri(uri: string): string {
  const base = uri.split("?")[0] ?? "";
  const pubkey = /^bunker:\/\/([0-9a-f]{64})$/i.exec(base)?.[1]?.toLowerCase();
  if (!pubkey) return "bunker://";
  return `bunker://${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

export function stripBunkerSecret(uri: string): string {
  const [base, query = ""] = uri.split("?");
  const params = new URLSearchParams(query);
  params.delete("secret");
  const rest = params.toString();
  return rest.length > 0 ? `${base}?${rest}` : (base ?? uri);
}

export function publicSigner(profile: Profile): Profile {
  if (profile.signer.kind !== "nip46") return profile;
  if (!profile.signer.bunkerUri) return profile;
  return { ...profile, signer: { kind: "nip46", bunkerUri: maskedBunkerUri(profile.signer.bunkerUri) } };
}
