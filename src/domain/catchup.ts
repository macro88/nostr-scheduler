import { InputError, type UnixSeconds } from "./brand.ts";
import type { CatchUpDecision } from "./types.ts";

export function decideCatchUp(args: {
  now: UnixSeconds;
  createdAt: UnixSeconds;
  windowSeconds: number;
}): CatchUpDecision {
  if (!Number.isInteger(args.windowSeconds) || args.windowSeconds < 0) {
    throw new InputError("catch_up", "window must be a non-negative whole number of seconds");
  }
  if (args.now < args.createdAt) return { action: "wait", fireAt: args.createdAt };
  const lateBySeconds = args.now - args.createdAt;
  if (lateBySeconds <= args.windowSeconds) return { action: "publish" };
  return { action: "missed", lateBySeconds };
}
