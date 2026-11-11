import type { ReactNode } from "react";
import { genericChangeError, plainError } from "./errors";

export function LoadingBlock({ pending, label }: { pending: boolean; label: string }) {
  if (!pending) return null;
  return (
    <div role="status" aria-busy="true" aria-label={label} data-testid="skeleton" className="stack">
      <div className="skeleton" />
      <div className="skeleton" />
    </div>
  );
}

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div data-testid="empty" className="desk-empty">
      <p className="empty-title">{title}</p>
      {action ? <div>{action}</div> : null}
    </div>
  );
}

export function InlineError({ error, fallback }: { error: unknown; fallback?: string }) {
  const plain = plainError(error);
  const message = fallback && plain.message === genericChangeError ? fallback : plain.message;
  return (
    <div role="alert" data-testid="inline-error" className="error">
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
