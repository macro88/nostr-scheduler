import { useQuery } from "@tanstack/react-query";
import { api, type Item } from "../api";
import { formatWhen } from "../format";
import { usePendingSurface } from "../pending";
import { InlineError, LoadingBlock } from "../states";

export function Log() {
  const log = useQuery({ queryKey: ["log"], queryFn: () => api<Item[]>("/api/log") });
  const surface = usePendingSurface(log.isPending && !log.data);
  return (
    <section data-testid="log" aria-label="Log">
      <div className="page-head compact">
        <div className="title-row">
          <h1 id="section-title" tabIndex={-1}>
            Log
          </h1>
          <p className="page-kicker">Sent and failed</p>
        </div>
      </div>
      {log.isPending && !log.data && !surface.loading ? <p className="sr">Loading the log</p> : null}
      <LoadingBlock pending={surface.loading} label="Loading the log" />
      {log.isError ? <InlineError error={log.error} fallback="The log could not be loaded. Try again." /> : null}
      {surface.ready && !log.isError && (log.data ?? []).length === 0 ? (
        <div data-testid="empty">
          <p>Nothing has been sent yet.</p>
        </div>
      ) : null}
      <div className="log-list">
        {(log.data ?? []).map((item) => (
          <article key={item.id} data-testid="log-item" className="log-row">
            <time>{item.fireAt[0] ? formatWhen(item.fireAt[0]) : ""}</time>
            <div className="log-body">
              <p className="note-md">{item.preview}</p>
              <ul>
                {(item.results ?? []).map((result, index) => (
                  <li key={`${result.relay}-${index}`} data-testid="relay-result" className="log-result">
                    {result.accepted ? `Accepted on ${result.relay}` : `The relay refused this note. ${result.relay}`}
                    {result.message ? ` ${result.message}` : ""}
                  </li>
                ))}
              </ul>
            </div>
            {item.status === "failed" ? <span className="status-flag status-failed">Failed</span> : <span className="status">Sent</span>}
          </article>
        ))}
      </div>
    </section>
  );
}
