export type RuntimeMode = "production" | "test" | "demo";

export function runtimeMode(env: NodeJS.ProcessEnv = process.env): RuntimeMode {
  if (env.NOSTR_SCHEDULER_MODE === "demo") return "demo";
  if (env.NOSTR_SCHEDULER_MODE === "test") return "test";
  if (env.NOSTR_SCHEDULER_MODE === "production") return "production";
  if (env.VITEST === "true" || env.NODE_ENV === "test") return "test";
  return "production";
}
