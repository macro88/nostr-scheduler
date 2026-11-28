import { InputError } from "../domain/brand.ts";
import type { OutlierSignals } from "../domain/research.ts";

export function engagementOf(signals: OutlierSignals): number {
  return signals.replies + signals.reposts + signals.reactions + signals.zaps;
}

export function scoreOutlier(input: { baselineEngagement: number; postEngagement: number }): number {
  const baseline = input.baselineEngagement;
  const post = input.postEngagement;
  if (!Number.isFinite(baseline) || baseline < 0 || !Number.isFinite(post) || post < 0) {
    throw new InputError("engagement", "expected a non-negative finite number");
  }
  if (baseline === 0) return post;
  return post / baseline;
}
