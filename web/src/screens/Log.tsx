import { useQuery } from "@tanstack/react-query";
import { api, type Item } from "../api";
import { StatusBadge } from "../components/ui";
import { formatWhen } from "../format";
import { usePendingSurface } from "../pending";
import { EmptyState, InlineError, LoadingBlock } from "../states";

export function Log() {
  const log = useQuery({ queryKey: ["log"], queryFn: () => api<Item[]>("/api/log") });
  const surface = usePendingSurface(log.isPending && !log.data);
  return (
    <section data-testid="log" aria-label="Log">
      <p className="text-sm text-[#5c564c]">Sent and failed</p>
      {log.isPending && !log.data && !surface.loading ? <p className="sr-only">Loading the log</p> : null}
      <LoadingBlock pending={surface.loading} label="Loading the log" />
      {log.isError ? <InlineError error={log.error} fallback="The log could not be loaded. Try again." /> : null}
      {surface.ready && !log.isError && (log.data ?? []).length === 0 ? <EmptyState title="Nothing has been sent yet." /> : null}
      <ul className="mt-6 space-y-3">
        {(log.data ?? []).map((item) => (
          <li key={item.id} data-testid="log-item" className="rounded-3xl bg-white p-5">
            <div className="flex items-center gap-2">
              <StatusBadge status={item.status} />
              <p className="text-sm text-[#5c564c]">{item.preview}</p>
              {item.fireAt[0] ? <time className="text-xs text-[#5c564c]">{formatWhen(item.fireAt[0])}</time> : null}
            </div>
            <ul className="mt-3 space-y-1 text-sm">
              {(item.results ?? []).map((result, index) => (
                <li key={`${result.relay}-${index}`} data-testid="relay-result">
                  {result.accepted ? `Accepted on ${result.relay}` : `The relay refused this note. ${result.relay}`}
                  {result.message ? ` ${result.message}` : ""}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
