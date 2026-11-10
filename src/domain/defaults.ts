export const DEFAULT_CATCH_UP_SECONDS = 15 * 60;
export const DEFAULT_SIGN_AHEAD_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_READ_NIP65 = false;
export const LOOPBACK_HOST = "127.0.0.1";

export function configuredSeconds(raw: string | undefined, fallback: number, field: string): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative whole number of seconds`);
  }
  return value;
}

export function catchUpWindowSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return configuredSeconds(env.NOSTR_SCHEDULER_CATCH_UP_SECONDS, DEFAULT_CATCH_UP_SECONDS, "catch-up window");
}

export function signAheadSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return configuredSeconds(env.NOSTR_SCHEDULER_SIGN_AHEAD_SECONDS, DEFAULT_SIGN_AHEAD_SECONDS, "sign-ahead horizon");
}
