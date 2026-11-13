import { npub as npubBrand, profileId, suggesterId, type ProfileId } from "../domain/brand.ts";
import { pubkeyFromNpub } from "../domain/bech32.ts";
import { InputError } from "../domain/brand.ts";
import { classifyPublishRelay } from "../domain/relays.ts";
import { assertValueHasNoPrivateKey } from "../domain/private-key.ts";
import { criteriaLocation } from "./criteria.ts";
import { profileEntries, readProfileDocument, writeProfileDocument } from "./file.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ProfileInput = {
  readonly label: string;
  readonly npub: string;
  readonly signer?: { kind: "nip07" } | { kind: "nip46"; bunkerUri?: string } | { kind: "nip55" };
  readonly criteriaPath: string;
  readonly relays: readonly string[];
  readonly readNip65: boolean;
  readonly allowPublicRelays: boolean;
};

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new InputError(field, "expected a string");
  return value.trim();
}

function identityOf(value: string): { npub: ReturnType<typeof npubBrand>; pubkey: string } {
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new InputError("npub", "That looks like a hex key. Paste the npub instead.");
  }
  if (!value.startsWith("npub1")) throw new InputError("npub", "That isn't an npub. It starts with npub1.");
  try {
    const encoded = npubBrand(value);
    return { npub: encoded, pubkey: pubkeyFromNpub(encoded) };
  } catch {
    throw new InputError("npub", "That isn't an npub. It starts with npub1.");
  }
}

function signerRecord(value: ProfileInput["signer"], previous: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (value.kind === "nip07") return { kind: "nip07" };
  if (value.kind === "nip55") return { kind: "nip55" };
  if (value.bunkerUri === undefined && isRecord(previous) && previous.kind === "nip46") return previous;
  const uri = value.bunkerUri?.trim() ?? "";
  if (uri === "") return { kind: "nip46" };
  if (!uri.startsWith("bunker://")) throw new InputError("bunker_uri", "expected a bunker URI");
  return { kind: "nip46", bunker_uri: uri };
}

export function parseProfileInput(value: unknown, partial: boolean): ProfileInput {
  assertValueHasNoPrivateKey(value);
  if (!isRecord(value)) throw new InputError("profile", "expected a mapping");
  if ("pubkey" in value) throw new InputError("npub", "That looks like a hex key. Paste the npub instead.");
  const label = text(value.label, "label");
  const encoded = text(value.npub, "npub");
  identityOf(encoded);
  const criteriaPath = text(value.criteriaPath ?? value.criteria_path, "criteria_path");
  if (!Array.isArray(value.relays) || value.relays.some((item) => typeof item !== "string")) {
    throw new InputError("relays", "expected a list of URLs");
  }
  const relays = value.relays.map((item) => classifyPublishRelay(item, true).url);
  const readRaw = value.readNip65 ?? value.read_nip65;
  const allowRaw = value.allowPublicRelays ?? value.allow_public_relays;
  if (readRaw !== undefined && typeof readRaw !== "boolean") throw new InputError("read_nip65", "expected a boolean");
  if (allowRaw !== undefined && typeof allowRaw !== "boolean") {
    throw new InputError("allow_public_relays", "expected a boolean");
  }
  let signer: ProfileInput["signer"];
  if (value.signer !== undefined) {
    if (!isRecord(value.signer) || typeof value.signer.kind !== "string") throw new InputError("signer", "expected a kind");
    if (value.signer.kind === "nip07") signer = { kind: "nip07" };
    else if (value.signer.kind === "nip55") signer = { kind: "nip55" };
    else if (value.signer.kind === "nip46") {
      const hasBunker = "bunkerUri" in value.signer || "bunker_uri" in value.signer;
      const bunkerUri = value.signer.bunkerUri ?? value.signer.bunker_uri;
      signer = { kind: "nip46", bunkerUri: hasBunker && typeof bunkerUri === "string" ? bunkerUri : undefined };
    } else throw new InputError("signer", "expected nip07, nip46, or nip55");
  } else if (!partial) {
    throw new InputError("signer", "expected a kind");
  }
  return {
    label,
    npub: encoded,
    signer,
    criteriaPath,
    relays,
    readNip65: readRaw === true,
    allowPublicRelays: allowRaw === true,
  };
}

function takenIds(entries: readonly Record<string, unknown>[], except?: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.id === "string" && entry.id !== except) ids.add(entry.id);
  }
  return ids;
}

function nextId(label: string, taken: Set<string>): string {
  const raw = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const stem = /^[a-z0-9]/.test(raw) ? raw.slice(0, 48) : "profile";
  let id = stem;
  let n = 2;
  while (taken.has(id)) {
    const suffix = `-${n}`;
    id = `${stem.slice(0, 63 - suffix.length)}${suffix}`;
    n += 1;
  }
  return profileId(id);
}

function assertUniqueNpub(entries: readonly Record<string, unknown>[], npub: string, except?: string): void {
  for (const entry of entries) {
    if (except && entry.id === except) continue;
    if (entry.npub === npub && typeof entry.label === "string") {
      throw new InputError("npub", `This npub already has a profile: ${entry.label}.`);
    }
  }
}

function applyOwned(entry: Record<string, unknown>, dataDir: string, input: ProfileInput, id: string, suggester: string | undefined): void {
  const identity = identityOf(input.npub);
  const criteria = criteriaLocation(dataDir, input.criteriaPath);
  const relays = input.relays.map((url) => classifyPublishRelay(url, input.allowPublicRelays).url);
  entry.id = id;
  entry.label = input.label;
  entry.npub = identity.npub;
  entry.pubkey = identity.pubkey;
  if (suggester) entry.suggester_id = suggesterId(suggester);
  const signer = signerRecord(input.signer, entry.signer);
  if (signer) entry.signer = signer;
  entry.criteria_path = criteria.relativePath;
  entry.relays = relays;
  entry.read_nip65 = input.readNip65;
  entry.allow_public_relays = input.allowPublicRelays;
}

export function createProfileRecord(file: string, dataDir: string, value: unknown): ProfileId {
  const input = parseProfileInput(value, false);
  const doc = readProfileDocument(file);
  const entries = profileEntries(doc);
  assertUniqueNpub(entries, input.npub);
  const id = nextId(input.label, takenIds(entries));
  const entry: Record<string, unknown> = {};
  applyOwned(entry, dataDir, input, id, `${id}-suggester`);
  entries.push(entry);
  doc.profiles = entries;
  writeProfileDocument(file, doc);
  return profileId(id);
}

export function updateProfileRecord(file: string, dataDir: string, id: string, value: unknown): void {
  const input = parseProfileInput(value, true);
  const doc = readProfileDocument(file);
  const entries = profileEntries(doc);
  const entry = entries.find((item) => item.id === id);
  if (!entry) throw new InputError("id", `no profile ${id}`);
  assertUniqueNpub(entries, input.npub, id);
  applyOwned(entry, dataDir, input, id, undefined);
  writeProfileDocument(file, doc);
}

export function deleteProfileRecord(file: string, id: string): void {
  const doc = readProfileDocument(file);
  const entries = profileEntries(doc);
  const next = entries.filter((item) => item.id !== id);
  if (next.length === entries.length) throw new InputError("id", `no profile ${id}`);
  doc.profiles = next;
  writeProfileDocument(file, doc);
}
