import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Item } from "../api";
import { Button, Input, StatusBadge } from "../components/ui";

function startOfWeek(date: Date): Date {
  const next = new Date(date);
  const day = (next.getDay() + 6) % 7;
  next.setDate(next.getDate() - day);
  next.setHours(0, 0, 0, 0);
  return next;
}

function sameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

export function Calendar({ profileId }: { profileId: string }) {
  const queryClient = useQueryClient();
  const items = useQuery({
    queryKey: ["items", profileId],
    queryFn: () => api<Item[]>(`/api/items?profileId=${profileId}`),
  });
  const [cursor, setCursor] = useState(() => startOfWeek(new Date()));
  const [mode, setMode] = useState<"week" | "day">("week");
  const [selected, setSelected] = useState<Item | null>(null);
  const [when, setWhen] = useState("");
  const visible = (items.data ?? []).filter((item) =>
    ["approved", "signed", "queued", "sent", "failed", "missed"].includes(item.status),
  );
  const days = mode === "week" ? Array.from({ length: 7 }, (_, index) => new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + index)) : [cursor];

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
      void queryClient.invalidateQueries({ queryKey: ["items", profileId] });
    },
  });
  const publish = useMutation({
    mutationFn: () => api("/api/publish", { method: "POST", body: "{}" }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const frozen = selected ? ["signed", "queued", "sent", "failed", "missed"].includes(selected.status) : false;

  return (
    <section data-testid="calendar">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{mode === "week" ? "Week" : "Day"}</h2>
        <div className="flex gap-2">
          <Button variant="outline" data-testid="prev" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - (mode === "week" ? 7 : 1)))}>
            Previous
          </Button>
          <Button variant="outline" data-testid="view-week" onClick={() => { setMode("week"); setCursor(startOfWeek(cursor)); }}>
            Week
          </Button>
          <Button variant="outline" data-testid="view-day" onClick={() => setMode("day")}>
            Day
          </Button>
          <Button variant="outline" data-testid="next" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + (mode === "week" ? 7 : 1)))}>
            Next
          </Button>
          <Button data-testid="publish-due" onClick={() => publish.mutate()} disabled={publish.isPending}>
            Publish due
          </Button>
        </div>
      </div>
      <div className={`mt-6 grid gap-3 ${mode === "week" ? "grid-cols-7" : "grid-cols-1"}`} data-testid={mode === "week" ? "week-grid" : "day-grid"}>
        {days.map((day) => {
          const hours = mode === "day" ? Array.from({ length: 24 }, (_, hour) => hour) : [0];
          return (
            <div key={day.toISOString()} className="min-h-48 rounded-3xl bg-white p-3">
              <p className="text-xs uppercase tracking-wide text-[#7a746a]">
                {day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
              </p>
              {hours.map((hour) => (
                <div key={hour} className={mode === "day" ? "mt-3 border-t border-[#f0ebe3] pt-2" : "mt-3 space-y-2"}>
                  {mode === "day" ? <p className="text-xs text-[#8a847a]">{String(hour).padStart(2, "0")}:00</p> : null}
                  {visible
                    .filter((item) => {
                      const stamp = item.fireAt[0];
                      if (!stamp) return false;
                      const date = new Date(stamp * 1000);
                      if (!sameDay(date, day)) return false;
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
                        <p className="mt-2 line-clamp-3 text-sm">{item.preview}</p>
                      </button>
                    ))}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {selected ? (
        <div data-testid="calendar-detail" className="mt-4 rounded-3xl border border-[#e4dfd4] bg-white p-5">
          <div className="flex items-center gap-2">
            <StatusBadge status={selected.status} />
            <p className="text-sm text-[#6d675d]">{selected.fireAt[0] ? new Date(selected.fireAt[0] * 1000).toLocaleString() : ""}</p>
          </div>
          <p className="mt-3 whitespace-pre-wrap">{selected.preview}</p>
          {frozen ? (
            <div className="mt-4">
              <p data-testid="frozen-note">This event is signed, so the time is frozen. Discard it and sign again to choose a new time.</p>
              <Button className="mt-3" variant="outline" data-testid="discard" onClick={() => discard.mutate()}>
                Discard
              </Button>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Input data-testid="reschedule" type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} />
              <Button data-testid="save-time" onClick={() => reschedule.mutate()} disabled={!when}>
                Move time
              </Button>
            </div>
          )}
          {reschedule.error || discard.error ? <p className="mt-2 text-sm text-[#8a2e24]">{(reschedule.error ?? discard.error)?.message}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
