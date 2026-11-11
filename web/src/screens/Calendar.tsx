import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { api, type Item } from "../api";
import { plainError } from "../errors";
import { weekExcerpt } from "../excerpt";
import { formatClock, formatQueueWhen, formatWhen, sameLocalDay, startOfWeek } from "../format";
import { statusWord } from "../labels";
import { usePendingSurface } from "../pending";
import { InlineError, LoadingBlock } from "../states";
import { useToasts } from "../toasts";
import { WhenField } from "../WhenField";

const weekOpen = 7;
const weekClose = 23;
const dayOpen = 8;
const dayClose = 21;

export function Calendar({ profileId }: { profileId: string }) {
  const queryClient = useQueryClient();
  const toasts = useToasts();
  const items = useQuery({
    queryKey: ["items", profileId],
    queryFn: () => api<Item[]>(`/api/items?profileId=${profileId}`),
  });
  const [cursor, setCursor] = useState(() => startOfWeek(new Date()));
  const [mode, setMode] = useState<"week" | "day">("week");
  const [selected, setSelected] = useState<Item | null>(null);
  const [when, setWhen] = useState(() => Math.floor(Date.now() / 1000) + 3600);
  const [confirming, setConfirming] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);
  const detailRef = useRef<HTMLDivElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const confirmingRef = useRef(false);
  confirmingRef.current = confirming;
  const surface = usePendingSurface(items.isPending && !items.data);
  const visible = (items.data ?? []).filter(
    (item) => !hidden.includes(item.id) && ["suggestion", "approved", "signed", "queued", "sent", "failed", "missed"].includes(item.status),
  );
  const days = mode === "week" ? Array.from({ length: 7 }, (_, index) => new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + index)) : [cursor];
  const canDiscard = selected?.status === "queued" || selected?.status === "signed";
  const canMove = selected?.status === "approved";
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const openHour = mode === "day" ? dayOpen : weekOpen;
  const closeHour = mode === "day" ? dayClose : weekClose;
  const span = closeHour - openHour;
  const nowFraction = (now.getHours() + now.getMinutes() / 60 - openHour) / span;

  const reschedule = useMutation({
    mutationFn: () => api(`/api/items/${selected?.id}/reschedule`, { method: "POST", body: JSON.stringify({ fireAt: when }) }),
    onSuccess: () => {
      setSelected(null);
      void queryClient.invalidateQueries({ queryKey: ["items", profileId] });
    },
  });
  const discard = useMutation({
    mutationFn: () => api(`/api/items/${selected?.id}/discard`, { method: "POST", body: JSON.stringify({ reason: "reschedule" }) }),
    onSuccess: () => {
      setSelected(null);
      setConfirming(false);
      toasts.push({ kind: "success", message: "Removed from the queue." });
      void queryClient.invalidateQueries({ queryKey: ["items", profileId] });
    },
    onError: (error) => toasts.push({ kind: "error", ...plainError(error) }),
  });
  const undoDiscard = (item: Item) => {
    setHidden((current) => [...current, item.id]);
    setSelected(null);
    toasts.push({
      kind: "undo",
      message: "Draft removed.",
      onUndo: () => setHidden((current) => current.filter((id) => id !== item.id)),
      onExpire: () => {
        void api(`/api/items/${item.id}/discard`, { method: "POST", body: JSON.stringify({ reason: "removed" }) })
          .then(() => queryClient.invalidateQueries({ queryKey: ["items", profileId] }))
          .catch((error) => {
            setHidden((current) => current.filter((id) => id !== item.id));
            toasts.push({ kind: "error", ...plainError(error) });
          });
      },
    });
  };
  const publish = useMutation({
    mutationFn: () => api("/api/publish", { method: "POST", body: "{}" }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirmingRef.current) {
        event.preventDefault();
        setConfirming(false);
        return;
      }
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const align = () => {
      if (mode !== "week") return;
      const board = boardRef.current;
      const today = board?.querySelector<HTMLElement>("[data-today='true']");
      if (!board || !today) return;
      const narrow = window.matchMedia("(max-width: 800px)").matches;
      if (!narrow) {
        today.scrollIntoView({ inline: "center", block: "nearest" });
        return;
      }
      const gutter = board.querySelector(".hour-gutter");
      const lane = board.querySelector(".lane.today");
      if (!gutter || !lane) return;
      const delta = lane.getBoundingClientRect().left - gutter.getBoundingClientRect().right;
      board.scrollLeft += delta;
    };
    align();
    window.addEventListener("resize", align);
    return () => window.removeEventListener("resize", align);
  }, [mode, cursor]);
  useEffect(() => {
    if (!confirming) return;
    const dialog = dialogRef.current;
    const focusable = () =>
      dialog ? [...dialog.querySelectorAll<HTMLElement>("button, [href], input, select, textarea")].filter((node) => !node.hasAttribute("disabled")) : [];
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const nodes = focusable();
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      root?.removeAttribute("inert");
      discardRef.current?.focus();
    };
  }, [confirming]);

  const range = `${days[0]?.toLocaleDateString("en-GB", { day: "numeric" })}–${days.at(-1)?.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
  const inView = visible.filter((item) => {
    const at = item.fireAt[0];
    return at !== undefined && days.some((day) => sameLocalDay(new Date(at * 1000), day));
  });
  const upcoming = [...inView].sort((left, right) => (left.fireAt[0] ?? 0) - (right.fireAt[0] ?? 0));
  const nowUnix = Math.floor(now.getTime() / 1000);
  const currentItem = [...upcoming].reverse().find((item) => {
    const at = item.fireAt[0];
    return at !== undefined && at <= nowUnix && sameLocalDay(new Date(at * 1000), now);
  });
  const nextItem = currentItem ?? upcoming.find((item) => (item.fireAt[0] ?? 0) >= nowUnix) ?? upcoming[0];
  const todayCount = inView.filter((item) => {
    const at = item.fireAt[0];
    return at !== undefined && sameLocalDay(new Date(at * 1000), now);
  }).length;
  const toSign = (items.data ?? []).filter((item) => item.status === "approved").length;
  const showNow = nowFraction > 0 && nowFraction < 1 && days.some((day) => sameLocalDay(day, now));

  return (
    <section data-testid="calendar" aria-label="Queue">
      <div className="page-head compact">
        <div className="title-row">
          <h1 id="section-title" tabIndex={-1}>
            Queue
          </h1>
          <p className="page-kicker">{mode === "week" ? range : cursor.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}</p>
        </div>
        <div className="toolbar">
          <button type="button" className="btn btn-outline btn-sm" data-testid="prev" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - (mode === "week" ? 7 : 1)))}>
            Previous
          </button>
          <div className="seg" role="group" aria-label="View">
            <button type="button" aria-pressed={mode === "week"} data-testid="view-week" onClick={() => { setMode("week"); setCursor(startOfWeek(cursor)); }}>
              Week
            </button>
            <button type="button" aria-pressed={mode === "day"} data-testid="view-day" onClick={() => { setMode("day"); setCursor(new Date()); }}>
              Day
            </button>
          </div>
          <button type="button" className="btn btn-outline btn-sm" data-testid="next" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + (mode === "week" ? 7 : 1)))}>
            Next
          </button>
          <span className="spacer" />
          <button type="button" className="btn btn-primary btn-sm" data-testid="publish-due" onClick={() => publish.mutate()} disabled={publish.isPending}>
            Publish due
          </button>
        </div>
      </div>
      {mode === "week" && nextItem?.fireAt[0] ? (
        <div className="next-up">
          <div className="next-up-copy">
            <time>{formatQueueWhen(nextItem.fireAt[0], now)}</time>
            <p>{nextItem.preview}</p>
            <StatusWord status={nextItem.status} />
          </div>
          <div className="counts" aria-label="This week">
            <div>
              <strong>{inView.length}</strong> this week
            </div>
            <div>
              <strong>{todayCount}</strong> today
            </div>
            <div>
              <strong>{toSign}</strong> to sign
            </div>
          </div>
        </div>
      ) : null}
      {publish.error ? <InlineError error={publish.error} /> : null}
      {items.isPending && !items.data && !surface.loading ? <p className="sr">Loading the queue</p> : null}
      <LoadingBlock pending={surface.loading} label="Loading the queue" />
      {items.isError ? <InlineError error={items.error} fallback="The queue could not be loaded. Try again." /> : null}
      {surface.ready && !items.isError && visible.length === 0 ? (
        <div data-testid="empty">
          <p>{mode === "week" ? "Nothing is scheduled this week." : "Nothing is scheduled this day."}</p>
        </div>
      ) : null}
      {surface.ready && mode === "week" ? (
        <div className="week-scroll" ref={boardRef} data-testid="week-grid">
          <div className="week-board" style={{ "--hours": String(span) } as CSSProperties}>
            <div className="gutter-head" />
            <div className="day-heads">
              {days.map((day) => (
                <div key={day.toISOString()} className={`day-head${sameLocalDay(day, now) ? " today" : ""}`} data-today={sameLocalDay(day, now) ? "true" : undefined}>
                  <p className="day-name">
                    {sameLocalDay(day, now) ? `${day.toLocaleDateString("en-GB", { weekday: "short" })}, today` : day.toLocaleDateString("en-GB", { weekday: "short" })}
                  </p>
                  <p className="day-num">{day.getDate()}</p>
                </div>
              ))}
            </div>
            <div className="hour-gutter" aria-hidden="true">
              {Array.from({ length: span + 1 }, (_, index) => {
                const hour = openHour + index;
                const atEnd = index === span;
                const collide = !atEnd && showNow && Math.abs(hour * 60 - (now.getHours() * 60 + now.getMinutes())) <= 20;
                if (collide) return null;
                return (
                  <span key={hour} className={atEnd ? "is-end" : undefined} style={{ top: `${(index / span) * 100}%` }}>
                    {String(hour).padStart(2, "0")}:00
                  </span>
                );
              })}
              {showNow ? (
                <span className="gutter-now" style={{ top: `${nowFraction * 100}%` }}>
                  {formatClock(now)}
                </span>
              ) : null}
            </div>
            <div className="week-lanes">
              {nowFraction > 0 && nowFraction < 1 ? (
                <div className="week-now" style={{ top: `${nowFraction * 100}%` }} aria-label={`Now, ${formatWhen(now)}`}>
                  <span className="sr">Now, {formatWhen(now)}</span>
                </div>
              ) : null}
              {days.map((day) => (
                <div key={day.toISOString()} className={`lane${sameLocalDay(day, now) ? " today" : ""}`}>
                  {visible
                    .filter((item) => item.fireAt[0] && sameLocalDay(new Date(item.fireAt[0] * 1000), day))
                    .map((item) => {
                      const date = new Date((item.fireAt[0] ?? 0) * 1000);
                      const fraction = (date.getHours() + date.getMinutes() / 60 - openHour) / span;
                      return (
                        <WeekCard
                          key={item.id}
                          item={item}
                          top={`${Math.min(Math.max(fraction, 0), 0.92) * 100}%`}
                          onSelect={() => setSelected(item)}
                        />
                      );
                    })}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      {surface.ready && mode === "day" ? (
        <div className="timetable" data-testid="day-grid" ref={boardRef}>
          <div className="hours">
            {Array.from({ length: span }, (_, index) => {
              const hour = openHour + index;
              const minutesNow = now.getHours() * 60 + now.getMinutes();
              const showNow = sameLocalDay(cursor, now) && now.getHours() === hour;
              const nearLabel = sameLocalDay(cursor, now) && Math.abs(hour * 60 - minutesNow) <= 20;
              return (
                <div key={hour} className="hour" data-today={nearLabel ? "true" : undefined}>
                  <p className={`hour-label${nearLabel ? " is-now" : ""}`}>{`${String(hour).padStart(2, "0")}:00`}</p>
                  <div className="hour-lane">
                    {showNow ? (
                      <div className="now-line" style={{ top: (now.getMinutes() / 60) * 48 }} aria-label={`Now, ${formatWhen(now)}`}>
                        <span>
                          {String(now.getHours()).padStart(2, "0")}:{String(now.getMinutes()).padStart(2, "0")}
                        </span>
                      </div>
                    ) : null}
                    {visible
                      .filter((item) => {
                        if (!item.fireAt[0]) return false;
                        const date = new Date(item.fireAt[0] * 1000);
                        return sameLocalDay(date, cursor) && date.getHours() === hour;
                      })
                      .map((item) => {
                        const date = new Date((item.fireAt[0] ?? 0) * 1000);
                        const track = 48;
                        const at = (date.getMinutes() / 60) * track;
                        const line = showNow ? (now.getMinutes() / 60) * track : -1;
                        const marginTop = line >= 0 && at <= line ? line + 10 : at;
                        return (
                        <button
                          key={item.id}
                          type="button"
                          className="slot-item"
                          data-testid="calendar-item"
                          style={{ marginTop }}
                          onClick={() => setSelected(item)}
                        >
                          <time>{formatClock(item.fireAt[0] ?? 0)}</time>
                          <p className="note-md">{item.preview}</p>
                          <span className="slot-status">
                            <StatusWord status={item.status} />
                          </span>
                        </button>
                        );
                      })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      {selected ? (
        <div ref={detailRef} data-testid="calendar-detail" className="detail-note">
          <p>
            <StatusWord status={selected.status} /> {selected.fireAt[0] ? formatQueueWhen(selected.fireAt[0], now) : ""}
          </p>
          <p className="note-md">{selected.preview}</p>
          {canDiscard ? (
            <div>
              {selected.status === "signed" ? (
                <p data-testid="frozen-note">This event is signed, so the time is frozen. Discard it and sign again to choose a new time.</p>
              ) : null}
              <button ref={discardRef} type="button" className="btn btn-outline" data-testid="discard" onClick={() => setConfirming(true)}>
                Discard
              </button>
            </div>
          ) : null}
          {canMove ? (
            <div className="actions">
              <WhenField value={when} onChange={setWhen} testId="reschedule" />
              <button type="button" className="btn btn-outline" data-testid="save-time" onClick={() => reschedule.mutate()}>
                Move time
              </button>
              <button type="button" className="btn btn-ghost" data-testid="remove-draft" onClick={() => undoDiscard(selected)}>
                Remove
              </button>
            </div>
          ) : null}
          {reschedule.error || discard.error ? <InlineError error={reschedule.error ?? discard.error} /> : null}
        </div>
      ) : null}
      {confirming && canDiscard
        ? createPortal(
            <div className="sheet-backdrop">
              <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="confirm-title" data-testid="confirm-discard" className="sheet">
                <p id="confirm-title">Discard this item from the queue?</p>
                <div className="actions">
                  <button type="button" className="btn btn-primary" data-testid="confirm-remove" onClick={() => discard.mutate()}>
                    Discard
                  </button>
                  <button type="button" className="btn btn-outline" onClick={() => setConfirming(false)}>
                    Keep
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}

function WeekCard({ item, top, onSelect }: { item: Item; top: string; onSelect: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [tall, setTall] = useState(false);
  const excerpt = weekExcerpt(item.preview);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setTall(node.getBoundingClientRect().height >= 44);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <button ref={ref} type="button" className="wevt" data-testid="calendar-item" style={{ top }} onClick={onSelect}>
      <div className="wevt-fit">
        <div className="meta">
          <time>{formatClock(item.fireAt[0] ?? 0)}</time>
          <StatusWord status={item.status} />
        </div>
        <p className="note-sm">{item.preview}</p>
        {excerpt && tall ? <p className="wevt-excerpt">{excerpt}</p> : null}
      </div>
    </button>
  );
}

function StatusWord({ status }: { status: string }) {
  if (status === "failed" || status === "missed") {
    return (
      <span className={`status-flag status-${status}`} data-testid={`status-${status}`}>
        {statusWord(status)}
      </span>
    );
  }
  return (
    <span className="status" data-testid={`status-${status}`}>
      {statusWord(status)}
    </span>
  );
}
