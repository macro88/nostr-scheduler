const marker = /nsec1/i;

export const pasteCode = "private_key_in_content";

export const pasteWarning =
  "This note contains a private key (nsec). Remove it before queuing. Never share your nsec: anyone who has it controls your account.";

export class PrivateKeyInContentError extends Error {
  readonly code = pasteCode;

  constructor() {
    super(pasteWarning);
    this.name = "PrivateKeyInContentError";
  }
}

export function containsPrivateKey(text: string): boolean {
  return marker.test(text);
}

export function valueHasPrivateKey(value: unknown): boolean {
  if (typeof value === "string") return containsPrivateKey(value);
  if (Array.isArray(value)) return value.some((item) => valueHasPrivateKey(item));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => valueHasPrivateKey(item));
  }
  return false;
}

export function assertValueHasNoPrivateKey(value: unknown): void {
  if (valueHasPrivateKey(value)) throw new PrivateKeyInContentError();
}

type GuardedDraft =
  | { readonly type: "note"; readonly content: string }
  | { readonly type: "reply"; readonly content: string; readonly parent?: { readonly content: string } }
  | { readonly type: "thread"; readonly segments: readonly { readonly content: string }[] };

export function draftContainsPrivateKey(draft: GuardedDraft): boolean {
  if (draft.type === "thread") return draft.segments.some((segment) => containsPrivateKey(segment.content));
  if (draft.type === "reply" && draft.parent && containsPrivateKey(draft.parent.content)) return true;
  return containsPrivateKey(draft.content);
}

export function assertNoPrivateKey(draft: GuardedDraft): void {
  if (draftContainsPrivateKey(draft)) throw new PrivateKeyInContentError();
}
