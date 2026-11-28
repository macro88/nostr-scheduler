import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import { Button, EmptyState, Input } from "@macro88/ui";
import { groupSuggestions, selectBriefs, type BriefView } from "../../../src/domain/pack.js";
import { api, type Item, type Profile } from "../api";
import { plainError } from "../errors";
import { formatWhen } from "../format";
import { singleKeyActive } from "../keys";
import { kindWord } from "../labels";
import { usePendingSurface } from "../pending";
import { InlineError, LoadingBlock } from "../states";
import { notifyError, notifySuccess, notifyUndo } from "../toasts";

export function Inbox({ profile, shortcuts, onCompose }: { profile: Profile; shortcuts: boolean; onCompose: () => void }) {
  const queryClient = useQueryClient();
  const items = useQuery({
    queryKey: ["items", profile.id],
    queryFn: () => api<Item[]>(`/api/items?profileId=${profile.id}`),
  });
  const research = useQuery({
    queryKey: ["research", profile.id],
    queryFn: () => api<unknown>(`/api/research?profileId=${profile.id}`),
  });
  const [hidden, setHidden] = useState<string[]>([]);
  const waiting = (items.data ?? []).filter((item) => item.status === "suggestion" && !hidden.includes(item.id));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const groups = groupSuggestions(
    waiting.map((item) => ({
      ...item,
      createdAt: item.createdAt ?? item.fireAt[0] ?? 0,
      rationale: item.rationale ?? "",
    })),
    { timeZone: zone },
  );
  const suggestions = groups.flatMap((group) => group.items);
  const briefs = selectBriefs(research.data);
  const briefPending = research.isPending && research.data === undefined;
  const showEmpty = suggestions.length === 0 && briefs.length === 0 && !briefPending;
  const packIndex = groups.findIndex((group) => group.label === "Morning pack");
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
      notifySuccess("Edit saved.");
      void refresh();
    },
    onError: (error) => notifyError(plainError(error).message),
  });
  const approve = useMutation({
    mutationFn: (id: string) => api(`/api/items/${id}/approve`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      notifySuccess("Approved.");
      void refresh();
    },
    onError: (error) => notifyError(plainError(error).message),
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
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--motion-exit-duration").trim();
      const parsed = Number.parseFloat(raw);
      const wait = Number.isFinite(parsed) ? (raw.endsWith("ms") || !raw.endsWith("s") ? parsed : parsed * 1000) : 160;
      window.setTimeout(done, wait);
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
      notifyUndo(
        "Suggestion rejected.",
        () => setHidden((current) => current.filter((id) => id !== item.id)),
        () => {
          void api(`/api/items/${item.id}/reject`, { method: "POST", body: JSON.stringify({ reason: note }) })
            .then(() => refresh())
            .catch((error) => {
              setHidden((current) => current.filter((id) => id !== item.id));
              notifyError(plainError(error).message);
            });
        },
      );
    });
  };
  const approveRow = (item: Item, source: "keyboard" | "pointer") => {
    const removed = suggestions.findIndex((entry) => entry.id === item.id);
    hideRow(item, source, () => {
      setHidden((current) => [...current, item.id]);
      focusNext(removed);
      void api(`/api/items/${item.id}/approve`, { method: "POST", body: "{}" })
        .then(() => {
          notifySuccess("Approved.");
          void refresh();
        })
        .catch((error) => {
          setHidden((current) => current.filter((id) => id !== item.id));
          notifyError(plainError(error).message);
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
        <div className={`desk${showEmpty ? " is-empty" : ""}`}>
          {showEmpty ? (
            <div className="desk-empty inbox-list" data-testid="empty">
              {research.isError ? <p className="brief-note" data-testid="brief-error">The daily brief could not be loaded.</p> : null}
              <EmptyState
                title="Nothing is waiting."
                action={
                  <Button type="button" variant="primary" onClick={onCompose}>
                    Write a note
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="inbox-list" aria-label="Suggestions">
              {briefPending && suggestions.length === 0 ? <p className="brief-note">Loading the daily brief</p> : null}
              {research.isError ? <p className="brief-note" data-testid="brief-error">The daily brief could not be loaded.</p> : null}
              {packIndex < 0 ? <BriefSection briefs={briefs} /> : null}
              {groups.map((group, groupIndex) => (
                <Fragment key={`${group.by}-${group.key}`}>
                  <section aria-labelledby={`pack-${group.by}-${group.key}`}>
                    <h2 id={`pack-${group.by}-${group.key}`} className="inbox-group">
                      {group.label}
                    </h2>
                    <div role="listbox" aria-label={group.label}>
                      {group.items.map((item) => {
                        const itemIndex = suggestions.findIndex((entry) => entry.id === item.id);
                        return (
                          <button
                            key={item.id}
                            type="button"
                            role="option"
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
                        );
                      })}
                    </div>
                  </section>
                  {groupIndex === packIndex ? <BriefSection briefs={briefs} /> : null}
                </Fragment>
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
                  <Button type="button" variant="primary" data-testid="approve" onClick={() => approveRow(selected, "pointer")} disabled={approve.isPending}>
                    Approve
                  </Button>
                  {editing ? (
                    <Button type="button" variant="outline" data-testid="save-edit" onClick={() => edit.mutate()} disabled={edit.isPending}>
                      Save edit
                    </Button>
                  ) : (
                    <Button type="button" variant="outline" data-testid="edit" onClick={() => setEditing(true)}>
                      Edit
                    </Button>
                  )}
                  {rejecting ? (
                    <>
                      <Input
                        label="Reason for rejecting"
                        data-testid="reject-reason"
                        placeholder="Reason for rejecting"
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && reason.trim()) queueReject(selected, reason.trim(), "keyboard");
                        }}
                      />
                      <Button type="button" variant="ghost" data-testid="reject" onClick={() => queueReject(selected, reason.trim(), "pointer")} disabled={!reason.trim()}>
                        Reject
                      </Button>
                    </>
                  ) : (
                    <Button type="button" variant="ghost" data-testid="reject-open" onClick={() => setRejecting(true)}>
                      Reject…
                    </Button>
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

function linkHost(url: string): string {
  return new URL(url).host;
}

function BriefSection({ briefs }: { briefs: readonly BriefView[] }) {
  if (briefs.length === 0) return null;
  return (
    <section aria-labelledby="daily-brief" data-testid="daily-brief">
      <h2 id="daily-brief" className="inbox-group">
        Daily brief
      </h2>
      <p className="brief-note">Research only. Remix a brief before it can be approved.</p>
      {briefs.map((brief) => (
        <article key={brief.id} className="brief-item" data-testid="brief">
          <h3>{brief.title}</h3>
          <p>{brief.summary}</p>
          {brief.url ? (
            <a href={brief.url} target="_blank" rel="noreferrer">
              {linkHost(brief.url)}
            </a>
          ) : null}
        </article>
      ))}
    </section>
  );
}
