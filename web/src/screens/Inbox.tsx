import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type Item, type Profile } from "../api";
import { Button, StatusBadge, Textarea } from "../components/ui";

export function Inbox({ profile }: { profile: Profile }) {
  const queryClient = useQueryClient();
  const items = useQuery({
    queryKey: ["items", profile.id],
    queryFn: () => api<Item[]>(`/api/items?profileId=${profile.id}`),
  });
  const suggestions = (items.data ?? []).filter((item) => item.status === "suggestion");
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [reason, setReason] = useState("");
  const selected = suggestions[index];

  useEffect(() => {
    setDraft(selected?.draft?.content ?? selected?.preview ?? "");
    setEditing(false);
  }, [selected?.id, selected?.draft?.content, selected?.preview]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["items", profile.id] });
  const edit = useMutation({
    mutationFn: () =>
      api(`/api/items/${selected?.id}/edit`, {
        method: "POST",
        body: JSON.stringify({
          draft: { type: "note", content: draft, proposedFireAt: selected?.draft?.proposedFireAt ?? selected?.fireAt[0] },
        }),
      }),
    onSuccess: () => {
      setEditing(false);
      void refresh();
    },
  });
  const approve = useMutation({
    mutationFn: () => api(`/api/items/${selected?.id}/approve`, { method: "POST", body: "{}" }),
    onSuccess: () => void refresh(),
  });
  const reject = useMutation({
    mutationFn: () => api(`/api/items/${selected?.id}/reject`, { method: "POST", body: JSON.stringify({ reason }) }),
    onSuccess: () => {
      setReason("");
      void refresh();
    },
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      if (event.key === "j") setIndex((value) => Math.min(suggestions.length - 1, value + 1));
      if (event.key === "k") setIndex((value) => Math.max(0, value - 1));
      if (event.key === "e") setEditing(true);
      if (event.key === "a" && selected) approve.mutate();
      if (event.key === "r") {
        const field = document.querySelector<HTMLInputElement>("[data-testid='reject-reason']");
        field?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approve, selected, suggestions.length]);

  return (
    <section data-testid="inbox">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-semibold">Inbox</h2>
        <p className="text-sm text-[#6d675d]">j/k move · a approve · e edit · r reject</p>
      </div>
      {suggestions.length === 0 ? <p className="mt-8 text-[#6d675d]">Nothing is waiting.</p> : null}
      <ul className="mt-6 space-y-3">
        {suggestions.map((item, itemIndex) => (
          <li key={item.id}>
            <article
              data-testid="suggestion"
              className={`rounded-3xl border bg-white p-5 ${itemIndex === index ? "border-[#1c1b17]" : "border-[#e4dfd4]"}`}
              onClick={() => setIndex(itemIndex)}
            >
              <div className="flex items-center justify-between gap-3">
                <StatusBadge status={item.status} />
                <time className="text-xs text-[#7a746a]">{item.fireAt[0] ? new Date(item.fireAt[0] * 1000).toLocaleString() : ""}</time>
              </div>
              {editing && itemIndex === index ? (
                <Textarea data-testid="edit-text" className="mt-4" value={draft} onChange={(event) => setDraft(event.target.value)} />
              ) : (
                <p className="mt-4 whitespace-pre-wrap text-lg leading-7">{item.preview}</p>
              )}
              {item.rationale ? <p className="mt-3 text-sm text-[#6d675d]">{item.rationale}</p> : null}
              {itemIndex === index ? (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button data-testid="approve" onClick={() => approve.mutate()} disabled={approve.isPending}>
                    Approve
                  </Button>
                  {editing ? (
                    <Button data-testid="save-edit" variant="outline" onClick={() => edit.mutate()} disabled={edit.isPending}>
                      Save edit
                    </Button>
                  ) : (
                    <Button data-testid="edit" variant="outline" onClick={() => setEditing(true)}>
                      Edit
                    </Button>
                  )}
                  <input
                    data-testid="reject-reason"
                    className="h-10 flex-1 rounded-full border border-[#d9d3c7] px-3 text-sm"
                    placeholder="Reason for rejecting"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <Button data-testid="reject" variant="ghost" onClick={() => reject.mutate()} disabled={!reason.trim() || reject.isPending}>
                    Reject
                  </Button>
                </div>
              ) : null}
              {edit.error || approve.error || reject.error ? (
                <p className="mt-2 text-sm text-[#8a2e24]">{(edit.error ?? approve.error ?? reject.error)?.message}</p>
              ) : null}
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}
