export type ExpiringToast = {
  onExpire?: () => void;
};

export function pushOnto<T extends ExpiringToast>(current: readonly T[], incoming: T, limit = 3): T[] {
  const next = [...current, incoming];
  const overflow = Math.max(0, next.length - limit);
  for (const toast of next.slice(0, overflow)) toast.onExpire?.();
  return next.slice(overflow);
}
