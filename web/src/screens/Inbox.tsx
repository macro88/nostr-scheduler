import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type Item, type Profile } from "../api";
import { Button, StatusBadge, Textarea } from "../components/ui";
import { plainError } from "../errors";
import { formatWhen } from "../format";
import { usePendingSurface } from "../pending";
import { EmptyState, InlineError, LoadingBlock } from "../states";
import { singleKeyActive } from "../keys";
import { useToasts } from "../toasts";

export function Inbox({ profile, shortcuts, onCompose }: { profile: Profile; shortcuts: boolean; onCompose: () => void }) {
  const queryClient = useQueryClient();
  const toasts = useToasts();
  const items = useQuery({
    queryKey: ["items", profile.id],
    queryFn: () => api<Item[]>(`/api/items?profileId=${profile.id}`),
  });
  const [hidden, setHidden] = useState<string[]>([]);
  const suggestions = (items.data ?? []).filter((item) => item.status === "suggestion" && !hidden.includes(item.id));
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [draft, setDraft] = useState("");
  const [reason, setReason] = useState("");
  const selected = suggestions[index];
  const surface = usePendingSurface(items.isPending && !items.data);
  const focusCard = useRef(false);

  useEffect(() => {
    if (editing) return;
    setDraft(selected?.draft?.content ?? selected?.preview ?? "");
  }, [editing, selected?.id, selected?.draft?.content, selected?.preview]);

  useEffect(() => {
    setEditing(false);
    setRejecting(false);
    setReason("");
  }, [selected?.id]);

  useEffect(() => {
    if (!focusCard.current) return;
    focusCard.current = false;
    document.querySelectorAll<HTMLElement>("[data-testid='suggestion']")[index]?.focus();
  }, [index]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["items"] });
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
      toasts.push({ kind: "success", message: "Edit saved." });
      void refresh();
    },
    onError: (error) => toasts.push({ kind: "error", ...plainError(error) }),
  });
  const approve = useMutation({
    mutationFn: (id: string) => api(`/api/items/${id}/approve`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      toasts.push({ kind: "success", message: "Approved." });
      void refresh();
    },
    onError: (error) => toasts.push({ kind: "error", ...plainError(error) }),
  });
  const queueReject = (item: Item, note: string) => {
    setHidden((current) => [...current, item.id]);
    setReason("");
    setRejecting(false);
    toasts.push({
      kind: "undo",
      message: "Suggestion rejected.",
      onUndo: () => setHidden((current) => current.filter((id) => id !== item.id)),
      onExpire: () => {
        void api(`/api/items/${item.id}/reject`, { method: "POST", body: JSON.stringify({ reason: note }) })
          .then(() => refresh())
          .catch((error) => {
            setHidden((current) => current.filter((id) => id !== item.id));
            toasts.push({ kind: "error", ...plainError(error) });
          });
      },
    });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setEditing(false);
        setRejecting(false);
        return;
      }
      if (!singleKeyActive(shortcuts, event.target)) return;
      if (event.key === "j" || event.key === "J") {
        focusCard.current = true;
        setIndex((value) => Math.min(suggestions.length - 1, value + 1));
      }
      if (event.key === "k" || event.key === "K") {
        focusCard.current = true;
        setIndex((value) => Math.max(0, value - 1));
      }
      if (event.key === "e" || event.key === "E") setEditing(true);
      if ((event.key === "a" || event.key === "A") && selected) approve.mutate(selected.id);
      if ((event.key === "r" || event.key === "R") && selected) {
        setRejecting(true);
        window.setTimeout(() => document.querySelector<HTMLInputElement>("[data-testid='reject-reason']")?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approve, selected, shortcuts, suggestions.length]);

  return (
    <section data-testid="inbox" aria-label="Inbox">
        <p className="text-sm text-[#5c564c]">J and K to move, A to approve, E to edit, R to reject.</p>
      {items.isPending && !items.data && !surface.loading ? <p className="sr-only">Loading suggestions</p> : null}
      <LoadingBlock pending={surface.loading} label="Loading suggestions" />
      {items.isError ? <InlineError error={items.error} fallback="The suggestions could not be loaded. Try again." /> : null}
      {surface.ready && !items.isError && suggestions.length === 0 ? (
        <EmptyState title="Nothing is waiting." action={<Button onClick={onCompose}>Write a note</Button>} />
      ) : null}
      {surface.ready && suggestions.length > 0 ? (
        <ul className="mt-6 space-y-3" aria-label="Suggestions">
          {suggestions.map((item, itemIndex) => (
            <li key={item.id}>
              <article
                data-testid="suggestion"
                tabIndex={0}
                aria-current={itemIndex === index ? "true" : undefined}
                className={`rounded-3xl border bg-white p-5 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1c1b17] ${itemIndex === index ? "border-[#1c1b17]" : "border-[#e4dfd4]"}`}
                onClick={() => setIndex(itemIndex)}
                onFocus={() => setIndex(itemIndex)}
              >
                <div className="flex items-center justify-between gap-3">
                  <StatusBadge status={item.status} />
                  <time className="text-xs text-[#5c564c]" dateTime={item.fireAt[0] ? new Date(item.fireAt[0] * 1000).toISOString() : undefined}>
                    {item.fireAt[0] ? formatWhen(item.fireAt[0]) : ""}
                  </time>
                </div>
                {editing && itemIndex === index ? (
                  <Textarea
                    data-testid="edit-text"
                    aria-label="Edit suggestion"
                    className="mt-4"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                ) : (
                  <p className="mt-4 whitespace-pre-wrap text-lg leading-7">{item.preview}</p>
                )}
                {item.rationale ? <p className="mt-3 text-sm text-[#5c564c]">{item.rationale}</p> : null}
                {itemIndex === index ? (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button data-testid="approve" onClick={() => approve.mutate(item.id)} disabled={approve.isPending}>
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
                    {rejecting ? (
                      <>
                        <input
                          data-testid="reject-reason"
                          aria-label="Reason for rejecting"
                          className="h-10 flex-1 rounded-full border border-[#8a8478] bg-white px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1c1b17]"
                          placeholder="Reason for rejecting"
                          value={reason}
                          onChange={(event) => setReason(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && reason.trim()) queueReject(item, reason.trim());
                          }}
                        />
                        <Button data-testid="reject" variant="ghost" onClick={() => queueReject(item, reason.trim())} disabled={!reason.trim()}>
                          Reject
                        </Button>
                      </>
                    ) : (
                      <Button data-testid="reject-open" variant="ghost" onClick={() => setRejecting(true)}>
                        Reject
                      </Button>
                    )}
                  </div>
                ) : null}
                {itemIndex === index && (edit.error || approve.error) ? <InlineError error={edit.error ?? approve.error} /> : null}
              </article>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
