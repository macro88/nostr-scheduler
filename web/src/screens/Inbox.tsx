import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@macro88/ui";
import { api, type Item, type Profile } from "../api";
import { plainError } from "../errors";
import { formatWhen } from "../format";
import { singleKeyActive } from "../keys";
import { kindWord } from "../labels";
import { usePendingSurface } from "../pending";
import { InlineError, LoadingBlock } from "../states";
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
  const focusNext = (removedIndex: number) => {
    const next = removedIndex < suggestions.length - 1 ? removedIndex : Math.max(0, suggestions.length - 2);
    setIndex(next);
    window.setTimeout(() => {
      const rows = document.querySelectorAll<HTMLElement>("[data-testid='suggestion']");
      const target = rows[next] ?? document.querySelector<HTMLElement>("[data-testid='empty'] button");
      target?.focus();
    }, 0);
  };
  const hideRow = (item: Item, source: "keyboard" | "pointer", done: () => void) => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const row = document.querySelector<HTMLElement>(`[data-row='${item.id}']`);
    if (source === "pointer" && !reduced && row) {
      row.classList.add("leaving");
      window.setTimeout(done, 160);
      return;
    }
    done();
  };
  const queueReject = (item: Item, note: string, source: "keyboard" | "pointer") => {
    const removed = suggestions.findIndex((entry) => entry.id === item.id);
    hideRow(item, source, () => {
      setHidden((current) => [...current, item.id]);
      setReason("");
      setRejecting(false);
      focusNext(removed);
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
    });
  };
  const approveRow = (item: Item, source: "keyboard" | "pointer") => {
    const removed = suggestions.findIndex((entry) => entry.id === item.id);
    hideRow(item, source, () => {
      setHidden((current) => [...current, item.id]);
      focusNext(removed);
      void api(`/api/items/${item.id}/approve`, { method: "POST", body: "{}" })
        .then(() => {
          toasts.push({ kind: "success", message: "Approved." });
          void refresh();
        })
        .catch((error) => {
          setHidden((current) => current.filter((id) => id !== item.id));
          toasts.push({ kind: "error", ...plainError(error) });
        });
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
      if ((event.key === "a" || event.key === "A") && selected) approveRow(selected, "keyboard");
      if ((event.key === "r" || event.key === "R") && selected) {
        setRejecting(true);
        window.setTimeout(() => document.querySelector<HTMLInputElement>("[data-testid='reject-reason']")?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approve, selected, shortcuts, suggestions.length]);

  return (
    <>
      <div className="page-head compact">
        <div className="title-row">
          <h1 id="section-title" tabIndex={-1}>
            Inbox
          </h1>
          {suggestions.length > 0 ? <p className="page-kicker">{suggestions.length} waiting</p> : null}
        </div>
        <div className="kbd-hints" role="note" aria-label="Keyboard shortcuts">
          <span className="kbd-group">
            <kbd>J</kbd> <kbd>K</kbd> move
          </span>
          <span className="kbd-group">
            <kbd>A</kbd> approve
          </span>
          <span className="kbd-group">
            <kbd>E</kbd> edit
          </span>
          <span className="kbd-group">
            <kbd>R</kbd> reject
          </span>
        </div>
      </div>
      {items.isPending && !items.data && !surface.loading ? <p className="sr">Loading suggestions</p> : null}
      <LoadingBlock pending={surface.loading} label="Loading suggestions" />
      {items.isError ? <InlineError error={items.error} fallback="The suggestions could not be loaded. Try again." /> : null}
      {surface.ready && !items.isError ? (
        <div className={`desk${suggestions.length === 0 ? " is-empty" : ""}`}>
          {suggestions.length === 0 ? (
            <div className="desk-empty inbox-list" data-testid="empty">
              <EmptyState
                title="Nothing is waiting."
                action={
                  <button type="button" className="btn btn-primary" onClick={onCompose}>
                    Write a note
                  </button>
                }
              />
            </div>
          ) : (
            <div className="inbox-list" role="listbox" aria-label="Suggestions">
              {suggestions.map((item, itemIndex) => (
                <button
                  key={item.id}
                  type="button"
                  className={`inbox-item${itemIndex === index ? " selected" : ""}`}
                  data-row={item.id}
                  data-testid="suggestion"
                  aria-selected={itemIndex === index}
                  onClick={() => setIndex(itemIndex)}
                >
                  <div className="meta">
                    <span className="status">{kindWord(item.draft?.type)}</span>
                    <time>{item.fireAt[0] ? formatWhen(item.fireAt[0]) : ""}</time>
                  </div>
                  <p className="preview note-md">{item.preview}</p>
                </button>
              ))}
            </div>
          )}
          <section className="inbox-detail" aria-label="Selected suggestion">
            {selected ? (
              <>
                <div className="detail-meta">
                  <span className="status">{kindWord(selected.draft?.type)}</span>
                  <time>{selected.fireAt[0] ? formatWhen(selected.fireAt[0]) : ""}</time>
                </div>
                {editing ? (
                  <textarea className="editor note-lg" data-testid="edit-text" aria-label="Edit suggestion" value={draft} onChange={(event) => setDraft(event.target.value)} />
                ) : (
                  <p className="detail-note note-lg">{selected.preview}</p>
                )}
                {selected.draft?.type === "reply" && selected.draft.parent ? (
                  <div className="thread">
                    <p className="thread-meta">{formatWhen(selected.draft.parent.at)}</p>
                    <q>{selected.draft.parent.content}</q>
                  </div>
                ) : null}
                {selected.rationale ? (
                  <p className="rationale">{selected.rationale.startsWith("Suggested because") ? selected.rationale : `Suggested because ${selected.rationale}`}</p>
                ) : null}
                <div className="actions">
                  <button type="button" className="btn btn-primary" data-testid="approve" onClick={() => approveRow(selected, "pointer")} disabled={approve.isPending}>
                    Approve
                  </button>
                  {editing ? (
                    <button type="button" className="btn btn-outline" data-testid="save-edit" onClick={() => edit.mutate()} disabled={edit.isPending}>
                      Save edit
                    </button>
                  ) : (
                    <button type="button" className="btn btn-outline" data-testid="edit" onClick={() => setEditing(true)}>
                      Edit
                    </button>
                  )}
                  {rejecting ? (
                    <>
                      <input
                        className="field"
                        data-testid="reject-reason"
                        aria-label="Reason for rejecting"
                        placeholder="Reason for rejecting"
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && reason.trim()) queueReject(selected, reason.trim(), "keyboard");
                        }}
                      />
                      <button type="button" className="btn btn-ghost" data-testid="reject" onClick={() => queueReject(selected, reason.trim(), "pointer")} disabled={!reason.trim()}>
                        Reject
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-ghost" data-testid="reject-open" onClick={() => setRejecting(true)}>
                      Reject…
                    </button>
                  )}
                </div>
                {edit.error || approve.error ? <InlineError error={edit.error ?? approve.error} /> : null}
              </>
            ) : (
              <p className="support">When a suggestion arrives, it opens here with the note, its time, and a way to approve it.</p>
            )}
          </section>
        </div>
      ) : null}
    </>
  );
}
