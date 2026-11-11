import type { ReactNode } from "react";
import { genericChangeError, plainError } from "./errors";

export function LoadingBlock({ pending, label }: { pending: boolean; label: string }) {
  if (!pending) return null;
  return (
    <div role="status" aria-busy="true" aria-label={label} data-testid="skeleton" className="mt-6 space-y-3">
      <div className="h-28 rounded-3xl bg-[#ebe6dc]" />
      <div className="h-28 rounded-3xl bg-[#ebe6dc]" />
    </div>
  );
}

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div data-testid="empty" className="mt-8">
      <p>{title}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function InlineError({ error, fallback }: { error: unknown; fallback?: string }) {
  const plain = plainError(error);
  const message = fallback && plain.message === genericChangeError ? fallback : plain.message;
  return (
    <div role="alert" data-testid="inline-error" className="mt-2 text-sm text-[#8a2e24]">
      <p>{message}</p>
      {plain.detail && plain.detail !== message ? (
        <details>
          <summary>Technical detail</summary>
          <p>{plain.detail}</p>
        </details>
      ) : null}
    </div>
  );
}
