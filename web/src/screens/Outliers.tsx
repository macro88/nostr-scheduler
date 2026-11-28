import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { EmptyState } from "@macro88/ui";
import { api, type ResearchOutlier } from "../api";
import { weekExcerpt } from "../excerpt";
import { shortNpub } from "../npub";
import { usePendingSurface } from "../pending";
import { InlineError, LoadingBlock } from "../states";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOutlier(value: unknown): value is ResearchOutlier {
  if (!isRecord(value) || !isRecord(value.signals)) return false;
  const signals = value.signals;
  return (
    value.kind === "outlier" &&
    typeof value.id === "string" &&
    typeof value.profileId === "string" &&
    typeof value.authorPubkey === "string" &&
    typeof value.eventId === "string" &&
    typeof value.content === "string" &&
    isFiniteNumber(value.multiplier) &&
    isFiniteNumber(value.baseline) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.scannedAt) &&
    isFiniteNumber(signals.replies) &&
    isFiniteNumber(signals.reposts) &&
    isFiniteNumber(signals.reactions) &&
    isFiniteNumber(signals.zaps)
  );
}

function formatMultiplier(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text}×`;
}

function signalLine(signals: ResearchOutlier["signals"]): string {
  return `${signals.replies} replies, ${signals.reposts} reposts, ${signals.reactions} reactions, ${signals.zaps} zaps`;
}

export function Outliers({ profileId }: { profileId: string }) {
  const research = useQuery({
    queryKey: ["research", profileId],
    queryFn: async () => {
      const rows = await api<unknown[]>(`/api/research?profileId=${profileId}`);
      return rows.filter(isOutlier);
    },
  });
  const rows = [...(research.data ?? [])].sort(
    (left, right) => right.multiplier - left.multiplier || right.createdAt - left.createdAt,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const surface = usePendingSurface(research.isPending && !research.data);

  return (
    <section data-testid="outliers" aria-label="Outliers">
      <div className="page-head compact">
        <div className="title-row">
          <h1 id="section-title" tabIndex={-1}>
            Outliers
          </h1>
          <p className="page-kicker">Public notes above the author baseline</p>
        </div>
      </div>
      {research.isPending && !research.data && !surface.loading ? <p className="sr">Loading outliers</p> : null}
      <LoadingBlock pending={surface.loading} label="Loading outliers" />
      {research.isError ? <InlineError error={research.error} fallback="The outliers could not be loaded. Try again." /> : null}
      {surface.ready && !research.isError ? (
        <div className={`desk${rows.length === 0 ? " is-empty" : ""}`}>
          {rows.length === 0 ? (
            <div className="desk-empty inbox-list" data-testid="empty">
              <EmptyState title="No outliers yet." />
            </div>
          ) : (
            <>
              <div className="inbox-list" role="listbox" aria-label="Outliers">
                {rows.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className={`inbox-item${selected?.id === row.id ? " selected" : ""}`}
                    data-testid="outlier-row"
                    aria-selected={selected?.id === row.id}
                    onClick={() => setSelectedId(row.id)}
                  >
                    <div className="meta">
                      <span className="status">{shortNpub(row.authorPubkey)}</span>
                      <span className="count" data-testid="outlier-multiplier">
                        {formatMultiplier(row.multiplier)}
                      </span>
                    </div>
                    <p className="preview note-md">{weekExcerpt(row.content)}</p>
                  </button>
                ))}
              </div>
              <section className="inbox-detail" aria-label="Selected outlier" data-testid="outlier-detail">
                {selected ? (
                  <>
                    <div className="detail-meta">
                      <span className="status" data-testid="outlier-author">
                        {shortNpub(selected.authorPubkey)}
                      </span>
                      <span className="count">{formatMultiplier(selected.multiplier)}</span>
                    </div>
                    <p className="detail-note note-lg">{selected.content}</p>
                    <p className="support">{signalLine(selected.signals)}</p>
                  </>
                ) : (
                  <p className="support">Select an outlier to read the note.</p>
                )}
              </section>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
