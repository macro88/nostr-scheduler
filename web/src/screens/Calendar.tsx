import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type Item } from "../api";
import { Button, Input, StatusBadge } from "../components/ui";
import { plainError } from "../errors";
import { formatWhen, sameLocalDay } from "../format";
import { usePendingSurface } from "../pending";
import { EmptyState, InlineError, LoadingBlock } from "../states";
import { useToasts } from "../toasts";

function startOfWeek(date: Date): Date {
  const next = new Date(date);
  const day = (next.getDay() + 6) % 7;
  next.setDate(next.getDate() - day);
  next.setHours(0, 0, 0, 0);
  return next;
}

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
  const [when, setWhen] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);
  const detailRef = useRef<HTMLDivElement>(null);
  const surface = usePendingSurface(items.isPending && !items.data);
  const visible = (items.data ?? []).filter(
    (item) => !hidden.includes(item.id) && ["approved", "signed", "queued", "sent", "failed", "missed"].includes(item.status),
  );
  const days = mode === "week" ? Array.from({ length: 7 }, (_, index) => new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + index)) : [cursor];
  const onView = visible.filter((item) => {
    const stamp = item.fireAt[0];
    if (!stamp) return false;
    const date = new Date(stamp * 1000);
    return days.some((day) => sameLocalDay(date, day));
  });

  const reschedule = useMutation({
    mutationFn: () => api(`/api/items/${selected?.id}/reschedule`, { method: "POST", body: JSON.stringify({ fireAt: Math.floor(new Date(when).getTime() / 1000) }) }),
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
  const canDiscard = selected?.status === "queued" || selected?.status === "signed";
  const canMove = selected?.status === "approved";
  const discardRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmingRef = useRef(false);
  confirmingRef.current = confirming;
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
    if (confirming) return;
    detailRef.current?.querySelector<HTMLElement>("input, button")?.focus();
  }, [selected?.id, confirming]);
  useEffect(() => {
    if (!confirming) return;
    const dialog = dialogRef.current;
    const focusable = () =>
      dialog
        ? [...dialog.querySelectorAll<HTMLElement>("button, [href], input, select, textarea")].filter((node) => !node.hasAttribute("disabled"))
        : [];
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0];
      const last = items[items.length - 1];
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

  return (
    <section data-testid="calendar" aria-label="Queue">
      <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="outline" data-testid="prev" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - (mode === "week" ? 7 : 1)))}>
            Previous
          </Button>
          <Button variant="outline" data-testid="view-week" onClick={() => { setMode("week"); setCursor(startOfWeek(cursor)); }}>
            Week
          </Button>
          <Button
            variant="outline"
            data-testid="view-day"
            onClick={() => {
              setMode("day");
              setCursor(new Date());
            }}
          >
            Day
          </Button>
          <Button variant="outline" data-testid="next" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + (mode === "week" ? 7 : 1)))}>
            Next
          </Button>
          <Button data-testid="publish-due" onClick={() => publish.mutate()} disabled={publish.isPending}>
            Publish due
          </Button>
      </div>
      {publish.error ? <InlineError error={publish.error} /> : null}
      {items.isPending && !items.data && !surface.loading ? <p className="sr-only">Loading the queue</p> : null}
      <LoadingBlock pending={surface.loading} label="Loading the queue" />
      {items.isError ? <InlineError error={items.error} fallback="The queue could not be loaded. Try again." /> : null}
      {surface.ready && !items.isError && onView.length === 0 ? (
        <EmptyState title={mode === "week" ? "Nothing is scheduled this week." : "Nothing is scheduled this day."} />
      ) : null}
      {surface.ready ? <div className={`mt-6 grid gap-3 ${mode === "week" ? "grid-cols-1 md:grid-cols-7" : "grid-cols-1"}`} data-testid={mode === "week" ? "week-grid" : "day-grid"}>
        {days.map((day) => {
          const hours = mode === "day" ? Array.from({ length: 24 }, (_, hour) => hour) : [0];
          return (
            <div key={day.toISOString()} className="min-h-48 rounded-3xl bg-white p-3">
              <p className="text-xs uppercase tracking-wide text-[#5c564c]">
                {day.toLocaleDateString("en-GB", { weekday: "short", month: "short", day: "numeric" })}
                {sameLocalDay(day, new Date()) ? <span className="ml-2 normal-case">Today</span> : null}
              </p>
              {hours.map((hour) => (
                <div key={hour} className={mode === "day" ? "mt-3 border-t border-[#f0ebe3] pt-2" : "mt-3 space-y-2"}>
                  {mode === "day" ? (
                    <p className="text-xs text-[#5c564c]">
                      {String(hour).padStart(2, "0")}:00
                      {sameLocalDay(day, new Date()) && new Date().getHours() === hour ? (
                        <span className="ml-2" aria-label={`Now, ${formatWhen(new Date())}`}>
                          Now, {formatWhen(new Date())}
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                  {visible
                    .filter((item) => {
                      const stamp = item.fireAt[0];
                      if (!stamp) return false;
                      const date = new Date(stamp * 1000);
                      if (!sameLocalDay(date, day)) return false;
                      return mode === "week" || date.getHours() === hour;
                    })
                    .map((item) => (
                      <button
                        key={item.id}
                        data-testid="calendar-item"
                        className="block w-full rounded-2xl bg-[#f7f4ee] p-2 text-left"
                        onClick={() => {
                          setSelected(item);
                          setWhen("");
                        }}
                      >
                        <StatusBadge status={item.status} />
                        <p className="mt-2 text-xs text-[#5c564c]">{item.fireAt[0] ? formatWhen(item.fireAt[0]) : ""}</p>
                        <p className="mt-1 line-clamp-3 text-sm">{item.preview}</p>
                      </button>
                    ))}
                </div>
              ))}
            </div>
          );
        })}
      </div> : null}
      {selected ? (
        <div ref={detailRef} tabIndex={-1} data-testid="calendar-detail" className="mt-4 rounded-3xl border border-[#e4dfd4] bg-white p-5 outline-none">
          <div className="flex items-center gap-2">
            <StatusBadge status={selected.status} />
            <p className="text-sm text-[#5c564c]">{selected.fireAt[0] ? formatWhen(selected.fireAt[0]) : ""}</p>
          </div>
          <p className="mt-3 whitespace-pre-wrap">{selected.preview}</p>
          {canDiscard ? (
            <div className="mt-4">
              <p data-testid="frozen-note">This event is signed, so the time is frozen. Discard it and sign again to choose a new time.</p>
              <Button ref={discardRef} className="mt-3" variant="outline" data-testid="discard" onClick={() => setConfirming(true)}>
                Discard
              </Button>
            </div>
          ) : null}
          {canMove ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Input data-testid="reschedule" aria-label="New time" type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} />
              <Button data-testid="save-time" onClick={() => reschedule.mutate()} disabled={!when}>
                Move time
              </Button>
              <Button variant="ghost" data-testid="remove-draft" onClick={() => selected && undoDiscard(selected)}>
                Remove
              </Button>
            </div>
          ) : null}
          {reschedule.error || discard.error ? <InlineError error={reschedule.error ?? discard.error} /> : null}
        </div>
      ) : null}
      {confirming && canDiscard
        ? createPortal(
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#1c1b17]/40 p-4">
              <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="confirm-title"
                data-testid="confirm-discard"
                className="w-full max-w-md rounded-3xl border border-[#8a8478] bg-white p-5"
              >
                <p id="confirm-title">Discard this item from the queue?</p>
                <div className="mt-3 flex gap-2">
                  <Button data-testid="confirm-remove" onClick={() => discard.mutate()}>
                    Discard
                  </Button>
                  <Button variant="outline" onClick={() => setConfirming(false)}>
                    Keep
                  </Button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
