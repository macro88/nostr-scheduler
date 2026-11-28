import { InputError } from "../domain/brand.ts";
import type { OutlierSignals } from "../domain/research.ts";

export function engagementOf(signals: OutlierSignals): number {
  return signals.replies + signals.reposts + signals.reactions + signals.zaps;
}

export function meanExcluding(values: readonly number[], skip: number): number {
  let sum = 0;
  let count = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (index === skip) continue;
    sum += values[index] ?? 0;
    count += 1;
  }
  if (count === 0) return 0;
  return sum / count;
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
