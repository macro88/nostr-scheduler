// Placeholders until @macro88/theme-nostr exports these names.
const hover = [0.25, 0.1, 0.25, 1] as const;
const out = [0.23, 1, 0.32, 1] as const;
const inOut = [0.77, 0, 0.175, 1] as const;
const fade = { type: "tween" as const, duration: 0.12, ease: "linear" as const };

const field = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { type: "tween" as const, duration: 0.12, ease: hover } },
  exit: { opacity: 0, transition: { type: "tween" as const, duration: 0.16, ease: out } },
};

const fieldReduced = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: fade },
  exit: { opacity: 0, transition: fade },
};

export const fieldCollapse = field;
export const fieldExpand = field;
export const fieldCollapseReduced = fieldReduced;
export const fieldExpandReduced = fieldReduced;

export const detailPush = {
  initial: { x: 28, opacity: 0 },
  animate: { x: 0, opacity: 1, transition: { type: "tween" as const, duration: 0.24, ease: inOut } },
  exit: { x: -28, opacity: 0, transition: { type: "tween" as const, duration: 0.16, ease: out } },
};

export const detailPop = {
  initial: { x: -28, opacity: 0 },
  animate: { x: 0, opacity: 1, transition: { type: "tween" as const, duration: 0.24, ease: inOut } },
  exit: { x: 28, opacity: 0, transition: { type: "tween" as const, duration: 0.16, ease: out } },
};

export const detailPushReduced = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: fade },
  exit: { opacity: 0, transition: fade },
};

export const detailPopReduced = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: fade },
  exit: { opacity: 0, transition: fade },
};

export function motionEase(ease: readonly number[] | string): string {
  if (typeof ease === "string") return "linear";
  const [a, b, c, d] = ease;
  return `cubic-bezier(${a}, ${b}, ${c}, ${d})`;
}
