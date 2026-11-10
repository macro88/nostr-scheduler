import type { UnixSeconds } from "./brand.ts";

export function assertWithinSignHorizon(args: {
  now: UnixSeconds;
  createdAt: UnixSeconds;
  maxAheadSeconds: number;
}): void {
  if (args.createdAt < args.now) {
    throw new Error("refusing to sign a created_at in the past");
  }
  if (args.createdAt > args.now + args.maxAheadSeconds) {
    throw new Error("refusing to sign more than the sign-ahead horizon");
  }
}
