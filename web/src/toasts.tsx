import { showError, showSuccess, showUndo, Toaster } from "@macro88/ui";

export { Toaster };

export function notifySuccess(message: string): void {
  showSuccess(message);
}

export function notifyError(message: string): void {
  showError(message);
}

export function notifyUndo(message: string, onUndo: () => void, onExpire: () => void): void {
  let settled = false;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--toast-duration-undo").trim();
  const parsed = Number.parseFloat(raw);
  const wait = Number.isFinite(parsed) ? (raw.endsWith("ms") || !raw.endsWith("s") ? parsed : parsed * 1000) : 6000;
  const timer = window.setTimeout(() => {
    if (settled) return;
    settled = true;
    onExpire();
  }, wait);
  showUndo(message, () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    onUndo();
  });
}
