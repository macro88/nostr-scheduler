import { duration, ease } from "@macro88/motion";

// Remove when the library ships this curve.
const hoverEase = [0.25, 0.1, 0.25, 1] as const;
// Remove when the library ships this curve.
const exitEase = [0.23, 1, 0.32, 1] as const;
// Remove when the library ships this curve.
const inOutEase = [0.77, 0, 0.175, 1] as const;
// Remove when the library ships a 160ms exit duration.
const exitDuration = 0.16;
// Remove when the library ships a 240ms move duration.
const moveDuration = 0.24;

function tween(seconds: number, curve: readonly [number, number, number, number]) {
  return { type: "tween" as const, duration: seconds, ease: curve };
}

const exit = tween(exitDuration, exitEase);
const feedback = tween(duration.fast, hoverEase);
const surface = tween(duration.base, exitEase);
const fade = tween(duration.fade, ease.linear);
const move = tween(moveDuration, inOutEase);

export const fieldCollapse = {
  outgoing: { opacity: 0, transition: exit },
  incoming: { opacity: 1, transition: feedback },
  container: { height: 0, transition: surface },
};

export const fieldExpand = {
  outgoing: { opacity: 0, transition: exit },
  incoming: { opacity: 1, transition: feedback },
  container: { height: "auto" as const, transition: surface },
};

export const fieldCollapseReduced = {
  outgoing: { opacity: 0, transition: fade },
  incoming: { opacity: 1, transition: fade },
  container: { height: "auto" as const, transition: fade },
};

export const fieldExpandReduced = fieldCollapseReduced;

const opacity = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: fade },
  exit: { opacity: 0, transition: fade },
};

export const detailPush = {
  detail: {
    initial: { x: 28, opacity: 0 },
    animate: { x: 0, opacity: 1, transition: move },
    exit: { x: -28, opacity: 0, transition: exit },
  },
  list: {
    initial: { x: 0, opacity: 1 },
    animate: { x: 0, opacity: 1 },
    exit: { x: -28, opacity: 0, transition: exit },
  },
};

export const detailPop = {
  detail: {
    initial: { x: 0, opacity: 1 },
    animate: { x: 0, opacity: 1 },
    exit: { x: 28, opacity: 0, transition: exit },
  },
  list: {
    initial: { x: -28, opacity: 0 },
    animate: { x: 0, opacity: 1, transition: move },
    exit: { x: 0, opacity: 1 },
  },
};

export const detailPushReduced = { detail: opacity, list: opacity };
export const detailPopReduced = { detail: opacity, list: opacity };
