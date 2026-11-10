export type Brand<T, B extends string> = T & { readonly __brand: B };

export type ProfileId = Brand<string, "ProfileId">;
export type SuggestionId = Brand<string, "SuggestionId">;
export type HexPubkey = Brand<string, "HexPubkey">;
export type Npub = Brand<string, "Npub">;
export type EventId = Brand<string, "EventId">;
export type Signature = Brand<string, "Signature">;
export type UnixSeconds = Brand<number, "UnixSeconds">;
export type RelayUrl = Brand<string, "RelayUrl">;
export type SuggesterId = Brand<string, "SuggesterId">;
export type CriteriaVersion = Brand<string, "CriteriaVersion">;

export class InputError extends Error {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`${field}: ${detail}`);
    this.name = "InputError";
    this.field = field;
  }
}

function brand<T, B extends string>(value: T): Brand<T, B> {
  return value as Brand<T, B>;
}

export function profileId(value: string): ProfileId {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new InputError("profile_id", "use a short lowercase token");
  }
  return brand(value);
}

export function suggestionId(value: string): SuggestionId {
  if (!/^sug_[a-z0-9]{2,32}$/.test(value)) {
    throw new InputError("suggestion_id", "expected sug_ followed by a short token");
  }
  return brand(value);
}

export function suggesterId(value: string): SuggesterId {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new InputError("suggester_id", "use a short lowercase token");
  }
  return brand(value);
}

export function hexPubkey(value: string): HexPubkey {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new InputError("pubkey", "expected 64 lowercase hex characters");
  }
  return brand(value);
}

export function npub(value: string): Npub {
  if (!value.startsWith("npub1") || value !== value.toLowerCase()) {
    throw new InputError("npub", "expected a lowercase npub");
  }
  return brand(value);
}

export function eventId(value: string): EventId {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new InputError("id", "expected 64 lowercase hex characters");
  }
  return brand(value);
}

export function signature(value: string): Signature {
  if (!/^[0-9a-f]{128}$/.test(value)) {
    throw new InputError("sig", "expected 128 lowercase hex characters");
  }
  return brand(value);
}

export function unixSeconds(value: number): UnixSeconds {
  if (!Number.isInteger(value) || value < 0) {
    throw new InputError("created_at", "expected a whole number of seconds");
  }
  return brand(value);
}

export function relayUrl(value: string): RelayUrl {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InputError("relay", "expected a websocket URL");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new InputError("relay", "expected a ws or wss URL");
  }
  if (parsed.username || parsed.password) {
    throw new InputError("relay", "relay URLs do not take credentials");
  }
  return brand(value);
}

export function criteriaVersion(value: string): CriteriaVersion {
  if (value.length === 0 || value.length > 64) {
    throw new InputError("version", "expected a short version string");
  }
  return brand(value);
}

export type NonEmpty<T> = readonly [T, ...T[]];

export function nonEmpty<T>(items: readonly T[], field: string): NonEmpty<T> {
  const first = items[0];
  if (first === undefined) throw new InputError(field, "expected at least one entry");
  return [first, ...items.slice(1)];
}
