import { InlineError as LibraryInlineError, Skeleton } from "@macro88/ui";
import { genericChangeError, plainError } from "./errors";

export function LoadingBlock({ pending, label }: { pending: boolean; label: string }) {
  if (!pending) return null;
  return (
    <div data-testid="skeleton" className="stack">
      <Skeleton label={label} />
    </div>
  );
}

export function InlineError({ error, fallback }: { error: unknown; fallback?: string }) {
  const plain = plainError(error);
  const message = fallback && plain.message === genericChangeError ? fallback : plain.message;
  return (
    <div data-testid="inline-error" className="error">
      <LibraryInlineError>{message}</LibraryInlineError>
      {plain.detail && plain.detail !== message ? (
        <details>
          <summary>Technical detail</summary>
          <p>{plain.detail}</p>
        </details>
      ) : null}
    </div>
  );
}
