function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function chipArc(dx: number, dy: number): { x: number; y: number }[] {
  const length = Math.hypot(dx, dy) || 1;
  const sagitta = clamp(length * 0.24, 32, 56);
  const midX = dx / 2;
  const midY = dy / 2;
  const vertical = Math.abs(dy) >= Math.abs(dx);
  const control = vertical ? { x: midX + sagitta * 2, y: midY } : { x: midX, y: midY - sagitta * 2 };
  return [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const u = 1 - t;
    return {
      x: 2 * u * t * control.x + t * t * dx,
      y: 2 * u * t * control.y + t * t * dy,
    };
  });
}

function reduced(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function showCheck(anchor: HTMLElement): void {
  const box = anchor.getBoundingClientRect();
  const mark = document.createElement("span");
  mark.className = "motion-check";
  mark.textContent = "✓";
  mark.style.left = `${box.left}px`;
  mark.style.top = `${box.top - 8 - 18}px`;
  document.body.append(mark);
  window.setTimeout(() => mark.remove(), reduced() ? 120 : 2100);
}

export function flyScheduleChip(source: HTMLElement, label: string): void {
  if (reduced()) return;
  const row = document.querySelector(".queue-pane .q-row");
  const pane = document.querySelector(".queue-pane");
  const nav = document.querySelector<HTMLElement>("[data-testid='nav-calendar']");
  const rowBox = row?.getBoundingClientRect();
  const paneBox = pane?.getBoundingClientRect();
  const rowVisible = Boolean(rowBox && paneBox && rowBox.top < window.innerHeight && rowBox.bottom > 0 && paneBox.width > 0);
  const target = rowVisible ? row : nav;
  if (!target) return;
  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const chip = document.createElement("span");
  chip.className = "schedule-chip";
  chip.textContent = label;
  chip.style.left = `${from.left}px`;
  chip.style.top = `${from.top}px`;
  document.body.append(chip);
  const frames = chipArc(dx, dy).map((point, index, all) => ({
    transform: `translate(${point.x}px, ${point.y}px)`,
    opacity: index < all.length - 1 ? 1 : 0,
  }));
  chip.animate(frames, { duration: 240, easing: "cubic-bezier(0.77, 0, 0.175, 1)", fill: "forwards" });
  if (!rowVisible) nav?.classList.add("nav-hit");
  window.setTimeout(() => {
    chip.remove();
    nav?.classList.remove("nav-hit");
  }, 260);
}
