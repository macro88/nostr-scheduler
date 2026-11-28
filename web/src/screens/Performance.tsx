import { useQuery } from "@tanstack/react-query";
import { EmptyState } from "@macro88/ui";
import { api } from "../api";
import { weekExcerpt } from "../excerpt";
import { usePendingSurface } from "../pending";
import { InlineError, LoadingBlock } from "../states";

type Signals = {
  replies: number;
  reposts: number;
  reactions: number;
  zaps: number;
};

type PerformanceNote = {
  eventId: string;
  content: string;
  createdAt: number;
  signals: Signals;
  multiplier: number;
  band: "top" | "bottom" | "middle";
  label: "Do more" | "Do less" | null;
};

type PerformanceReport = {
  fraction: number;
  topCutoff: number | null;
  bottomCutoff: number | null;
  notes: PerformanceNote[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSignals(value: unknown): value is Signals {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.replies) &&
    isFiniteNumber(value.reposts) &&
    isFiniteNumber(value.reactions) &&
    isFiniteNumber(value.zaps)
  );
}

function isNote(value: unknown): value is PerformanceNote {
  if (!isRecord(value) || !isSignals(value.signals)) return false;
  const labelOk =
    (value.band === "top" && value.label === "Do more") ||
    (value.band === "bottom" && value.label === "Do less") ||
    (value.band === "middle" && value.label === null);
  return (
    labelOk &&
    typeof value.eventId === "string" &&
    typeof value.content === "string" &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.multiplier) &&
    value.multiplier >= 0
  );
}

function parseReport(value: unknown): PerformanceReport {
  if (!isRecord(value) || !Array.isArray(value.notes) || !isFiniteNumber(value.fraction)) {
    throw new Error("The performance view was unreadable.");
  }
  if (value.topCutoff !== null && !isFiniteNumber(value.topCutoff)) throw new Error("The performance view was unreadable.");
  if (value.bottomCutoff !== null && !isFiniteNumber(value.bottomCutoff)) throw new Error("The performance view was unreadable.");
  const notes: PerformanceNote[] = [];
  for (const note of value.notes) {
    if (!isNote(note)) throw new Error("The performance view was unreadable.");
    notes.push(note);
  }
  return {
    fraction: value.fraction,
    topCutoff: value.topCutoff,
    bottomCutoff: value.bottomCutoff,
    notes,
  };
}

function formatMultiplier(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text}×`;
}

function countWord(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function signalLine(signals: Signals): string {
  return [
    countWord(signals.replies, "reply", "replies"),
    countWord(signals.reposts, "repost", "reposts"),
    countWord(signals.reactions, "reaction", "reactions"),
    countWord(signals.zaps, "zap", "zaps"),
  ].join(", ");
}

function NoteList({ notes }: { notes: readonly PerformanceNote[] }) {
  return (
    <ul className="performance-list" role="list">
      {notes.map((note) => (
        <li key={note.eventId} className="performance-note" role="listitem" data-testid="performance-note">
          <p className="count" data-testid="performance-multiplier">
            {formatMultiplier(note.multiplier)}
          </p>
          <div>
            <p className="note-md">{weekExcerpt(note.content)}</p>
            <p className="log-result" data-testid="performance-signals">
              {signalLine(note.signals)}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Band({ notes, testId }: { notes: readonly PerformanceNote[]; testId: string }) {
  const label = notes[0]?.label;
  if (!label) return null;
  return (
    <section data-testid={testId}>
      <h2>{label}</h2>
      <NoteList notes={notes} />
    </section>
  );
}

export function Performance({ profileId }: { profileId: string }) {
  const reportQuery = useQuery({
    queryKey: ["performance", profileId],
    queryFn: async () => parseReport(await api<unknown>(`/api/performance?profileId=${profileId}`)),
  });
  const report = reportQuery.data;
  const notes = report?.notes ?? [];
  const top = notes.filter((note) => note.label === "Do more");
  const bottom = notes.filter((note) => note.label === "Do less");
  const middle = notes.length - top.length - bottom.length;
  const short = Boolean(report && report.topCutoff === null && notes.length > 0);
  const percent = report ? Math.round(report.fraction * 100) : 20;
  const kicker = short ? "Your public notes." : `Your public notes. Top and bottom ${percent}%.`;
  const surface = usePendingSurface(reportQuery.isPending && !reportQuery.data);

  return (
    <section data-testid="performance" aria-label="Performance">
      <div className="page-head compact">
        <div className="title-row">
          <h1 id="section-title" tabIndex={-1}>
            Performance
          </h1>
          <p className="page-kicker">{kicker}</p>
        </div>
      </div>
      {reportQuery.isPending && !reportQuery.data && !surface.loading ? <p className="sr">Loading performance</p> : null}
      <LoadingBlock pending={surface.loading} label="Loading performance" />
      {reportQuery.isError ? <InlineError error={reportQuery.error} fallback="Your notes could not be loaded. Try again." /> : null}
      {surface.ready && !reportQuery.isError && notes.length === 0 ? (
        <div data-testid="empty">
          <EmptyState title="No public notes on your relays yet." />
        </div>
      ) : null}
      {surface.ready && !reportQuery.isError && notes.length > 0 ? (
        <div className="performance-bands">
          {short ? (
            <section data-testid="performance-short">
              <h2>Notes</h2>
              <NoteList notes={notes} />
              <p className="page-kicker">Fewer than five public notes, so there is no top or bottom band yet.</p>
            </section>
          ) : (
            <>
              <Band notes={top} testId="band-top" />
              <Band notes={bottom} testId="band-bottom" />
              {middle > 0 ? (
                <p className="page-kicker" data-testid="band-middle">
                  {middle === 1 ? "1 note is between the bands." : `${middle} notes are between the bands.`}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
