const STORAGE_KEY = "nostr-scheduler-shortcuts";

const textInputTypes = new Set([
  "text",
  "search",
  "email",
  "url",
  "password",
  "tel",
  "number",
  "date",
  "datetime-local",
  "time",
  "month",
  "week",
]);

type FocusLike = {
  tagName?: string;
  isContentEditable?: boolean;
  type?: string;
};

export function readShortcutsEnabled(storage: { getItem(key: string): string | null } | null): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeShortcutsEnabled(storage: { setItem(key: string, value: string): void }, enabled: boolean): void {
  storage.setItem(STORAGE_KEY, enabled ? "on" : "off");
}

export function typingTarget(target: EventTarget | FocusLike | null): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as FocusLike;
  if (element.isContentEditable) return true;
  if (element.tagName === "TEXTAREA" || element.tagName === "SELECT") return true;
  if (element.tagName === "INPUT") return textInputTypes.has(element.type ?? "text");
  return false;
}

export function singleKeyActive(enabled: boolean, target: EventTarget | FocusLike | null): boolean {
  return enabled && !typingTarget(target);
}
