import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Input } from "@macro88/ui";
import { api, type Item, type Profile } from "../api";
import { draftsOf, type DraftRow } from "../drafts";
import { previewParts } from "../preview";
import { formatQueueWhen, formatWhen, localZoneLabel, startOfWeek } from "../format";
import { StatusMark } from "../status";
import { containsPrivateKey, pasteWarning } from "../../../src/domain/private-key.js";
import { InlineError } from "../states";
import { notifySuccess } from "../toasts";
import { flyScheduleChip } from "../theme/motion";
import { WhenField } from "../WhenField";

type Kind = "note" | "thread" | "reply";

const unknownCopy = "This schedule is not confirmed yet. Check the queue, then try again if the note is not there.";
const pendingCopy = "Scheduling…";

class ScheduleUnknown extends Error {
  constructor() {
    super("unconfirmed");
    this.name = "ScheduleUnknown";
  }
}

class ScheduleBusy extends Error {
  constructor() {
    super("busy");
    this.name = "ScheduleBusy";
  }
}

type Snapshot =
  | { type: "note"; content: string; proposedFireAt: number }
  | { type: "thread"; segments: { content: string; proposedFireAt: number }[] }
  | { type: "reply"; content: string; proposedFireAt: number; target: { eventId: string; rootId: string; pubkey: string; relayHint?: string }; parent?: { at: number; content: string } };

type ScheduleAttempt = {
  profileId: string;
  intentId: string;
  draftId: string | null;
  draft: Snapshot;
  revision: number;
};

type ReplyCarry = {
  target: { eventId: string; rootId: string; pubkey: string; relayHint?: string };
  parent?: { at: number; content: string };
};

function sameSnapshot(left: Snapshot, right: Snapshot): boolean {
  if (left.type === "note" && right.type === "note") return left.content === right.content && left.proposedFireAt === right.proposedFireAt;
  if (left.type === "thread" && right.type === "thread") {
    return left.segments.length === right.segments.length && left.segments.every((segment, index) => segment.content === right.segments[index]?.content && segment.proposedFireAt === right.segments[index]?.proposedFireAt);
  }
  if (left.type === "reply" && right.type === "reply") {
    const sameParent = (left.parent === undefined && right.parent === undefined) || (left.parent !== undefined && right.parent !== undefined && left.parent.at === right.parent.at && left.parent.content === right.parent.content);
    return left.content === right.content && left.proposedFireAt === right.proposedFireAt && left.target.eventId === right.target.eventId && left.target.rootId === right.target.rootId && left.target.pubkey === right.target.pubkey && (left.target.relayHint ?? "") === (right.target.relayHint ?? "") && sameParent;
  }
  return false;
}

type StoredMatch = "scheduled" | "absent" | "unread" | "open" | "held";

function lostResponse(error: unknown): boolean {
  if (error instanceof ScheduleUnknown) return true;
  if (error instanceof TypeError || error instanceof SyntaxError) return true;
  if (!(error instanceof Error)) return false;
  return /failed to fetch|network|aborted|abort/i.test(error.message);
}

function intentId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `sug_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function sameIntent(item: Item, attempt: ScheduleAttempt): boolean {
  if (item.id !== attempt.intentId || item.profileId !== attempt.profileId || !item.draft) return false;
  const draft = item.draft;
  if (draft.type === "note" && typeof draft.content === "string" && typeof draft.proposedFireAt === "number") {
    return sameSnapshot({ type: "note", content: draft.content, proposedFireAt: draft.proposedFireAt }, attempt.draft);
  }
  if (draft.type === "thread" && draft.segments) {
    return sameSnapshot({ type: "thread", segments: draft.segments }, attempt.draft);
  }
  if (draft.type === "reply" && typeof draft.content === "string" && typeof draft.proposedFireAt === "number" && draft.target) {
    return sameSnapshot({ type: "reply", content: draft.content, proposedFireAt: draft.proposedFireAt, target: draft.target, ...(draft.parent ? { parent: draft.parent } : {}) }, attempt.draft);
  }
  return false;
}

const scheduledStatus = new Set(["approved", "signed", "queued", "sent"]);

async function readIntent(attempt: ScheduleAttempt): Promise<StoredMatch> {
  try {
    const items = await api<Item[]>(`/api/items?profileId=${attempt.profileId}`);
    const item = items.find((entry) => entry.id === attempt.intentId);
    if (!item) return "absent";
    if (!sameIntent(item, attempt)) return "held";
    if (scheduledStatus.has(item.status)) return "scheduled";
    if (item.status === "draft") return "open";
    return "held";
  } catch {
    return "unread";
  }
}

function idAlreadyUsed(error: unknown): boolean {
  return error instanceof Error && /already used/i.test(error.message);
}

const repairCopy = "This note has not been scheduled. Repair this profile’s local setup to continue. Your text and chosen time stay here.";
const keepCopy = "Unsaved text is lost on reload. Save it to keep it in Queue.";

export function Composer({ profile, onRepair, onViewQueue, headingId }: { profile: Profile; onRepair?: () => void; onViewQueue?: () => void; headingId?: string }) {
  const queryClient = useQueryClient();
  const editor = useRef<HTMLTextAreaElement>(null);
  const [kind, setKind] = useState<Kind>("note");
  const [when, setWhen] = useState(() => Math.floor(Date.now() / 1000) + 60 * 60);
  const [note, setNote] = useState("");
  const [parts, setParts] = useState(["", ""]);
  const [ref, setRef] = useState("");
  const [context, setContext] = useState("");
  const [reply, setReply] = useState("");
  const [formError, setFormError] = useState<unknown>(null);
  const [unconfirmed, setUnconfirmed] = useState<ScheduleAttempt | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [replyCarry, setReplyCarry] = useState<ReplyCarry | null>(null);
  const scheduling = useRef(false);
  const draftsMarked = useRef(false);
  const revision = useRef(0);
  const noteNow = useRef(note);
  const whenNow = useRef(when);
  noteNow.current = note;
  whenNow.current = when;
  useEffect(() => {
    revision.current += 1;
    setDraftId(null);
    setReplyCarry(null);
  }, [profile.id]);
  const [wide, setWide] = useState(() => typeof window === "undefined" || window.matchMedia("(min-width: 801px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 801px)");
    const onChange = () => setWide(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const queue = useQuery({
    queryKey: ["items", profile.id],
    queryFn: () => api<Item[]>(`/api/items?profileId=${profile.id}`),
  });
  if (queue.isSuccess && !draftsMarked.current) {
    draftsMarked.current = true;
    performance.mark("drafts-data-ready");
  }
  useLayoutEffect(() => {
    if (!queue.isSuccess || performance.getEntriesByName("drafts-data-ready").length === 0) return;
    if (performance.getEntriesByName("drafts-list-paint").length > 0) return;
    performance.mark("drafts-painted");
    performance.measure("drafts-list-paint", "drafts-data-ready", "drafts-painted");
  }, [queue.isSuccess, queue.data]);
  const weekStart = Math.floor(startOfWeek(new Date()).getTime() / 1000);
  const weekEnd = weekStart + 7 * 24 * 60 * 60;
  const stored = (queue.data ?? []).filter((item) => ["draft", "suggestion", "approved", "signed", "queued", "sent", "failed", "missed"].includes(item.status));
  const drafts = draftsOf(stored, profile.id);
  const scheduled = stored.filter((item) => item.status !== "draft");
  const upcoming = scheduled
    .filter((item) => {
      const at = item.fireAt[0] ?? 0;
      return at >= weekStart && at < weekEnd;
    })
    .sort((left, right) => (left.fireAt[0] ?? 0) - (right.fireAt[0] ?? 0));
  useLayoutEffect(() => {
    const node = editor.current;
    if (!node) return;
    node.style.height = "";
  }, [note, reply, parts, kind]);
  const title = kind === "thread" ? "Write a thread" : kind === "reply" ? "Write a reply" : "Write a note";
  const text = kind === "note" ? note : kind === "reply" ? reply : parts[0] ?? "";
  const texts = kind === "note" ? [note] : kind === "reply" ? [reply] : parts;
  const blocked = texts.some((value) => containsPrivateKey(value));
  const draftText = text.trim();
  const livePreview = kind === "thread" ? parts.join("\n") : kind === "reply" ? reply : note;
  const matchesSaved = drafts.some((row) => row.preview === livePreview && row.fireAt === when);
  const queueRows = draftText && !blocked && !matchesSaved
    ? [...upcoming, { id: "composer-draft", fireAt: [when], preview: draftText, status: "suggestion" }].sort(
        (left, right) => (left.fireAt[0] ?? 0) - (right.fireAt[0] ?? 0),
      )
    : upcoming;

  function currentDraft(): Snapshot {
    const fireAt = when;
    if (!Number.isFinite(fireAt) || fireAt <= Math.floor(Date.now() / 1000)) throw new Error("created_at in the past");
    if (fireAt > Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60) throw new Error("further ahead than the sign-ahead horizon");
    if (texts.some((value) => containsPrivateKey(value))) throw new Error(pasteWarning);
    if (kind === "note") return { type: "note", content: note, proposedFireAt: fireAt };
    if (kind === "thread") return { type: "thread", segments: parts.map((content, index) => ({ content, proposedFireAt: fireAt + index })) };
    const parsed = JSON.parse(contextTarget(context, ref)) as { eventId: string; rootId: string; pubkey: string; relayHint?: string };
    const carried = replyCarry && replyCarry.target.eventId === parsed.eventId ? replyCarry : null;
    return { type: "reply", content: reply, proposedFireAt: fireAt, target: carried ? carried.target : parsed, ...(carried?.parent ? { parent: carried.parent } : {}) };
  }

  const save = useMutation({
    mutationFn: async () => {
      if (scheduling.current) throw new ScheduleBusy();
      scheduling.current = true;
      let attempt: ScheduleAttempt | null = null;
      try {
        if (profile.criteriaState === "invalid") throw new Error(repairCopy);
        const draft = currentDraft();
        const reusable = unconfirmed && unconfirmed.profileId === profile.id && sameSnapshot(unconfirmed.draft, draft) ? unconfirmed : null;
        attempt = {
          profileId: profile.id,
          intentId: reusable?.intentId ?? draftId ?? intentId(),
          draftId: reusable?.draftId ?? draftId,
          draft,
          revision: revision.current,
        };
        if (reusable) {
          const found = await readIntent(attempt);
          if (found === "scheduled") return { id: attempt.intentId, attempt };
          if (found === "unread" || found === "held") {
            setUnconfirmed(attempt);
            throw new ScheduleUnknown();
          }
        }
        if (attempt.draftId) {
          await api(`/api/drafts`, { method: "POST", body: JSON.stringify({ profileId: profile.id, id: attempt.draftId, draft }) });
          const approved = await api<{ id: string }>(`/api/items/${attempt.draftId}/approve`, { method: "POST", body: "{}" });
          return { ...approved, attempt };
        }
        const created = await api<{ id: string }>("/api/compose", {
          method: "POST",
          body: JSON.stringify({ profileId: profile.id, id: attempt.intentId, draft }),
        });
        return { ...created, attempt: { ...attempt, intentId: created.id || attempt.intentId } };
      } catch (error) {
        if (error instanceof ScheduleUnknown || error instanceof ScheduleBusy || !attempt) throw error;
        const found = await readIntent(attempt);
        if (found === "scheduled") return { id: attempt.intentId, attempt };
        if (found === "held" || idAlreadyUsed(error) || lostResponse(error) || found === "unread" || found === "open") {
          setUnconfirmed(attempt);
          throw new ScheduleUnknown();
        }
        throw error;
      } finally {
        scheduling.current = false;
      }
    },
    onSuccess: (result) => {
      const attempt = result.attempt;
      setUnconfirmed((current) => (current && current.intentId === attempt.intentId ? null : current));
      let live: Snapshot | null = null;
      try {
        live = currentDraft();
      } catch {
        live = null;
      }
      const same = attempt.revision === revision.current && attempt.profileId === profile.id && live !== null && sameSnapshot(attempt.draft, live);
      void queryClient.invalidateQueries({ queryKey: ["items"] });
      if (!same) return;
      const button = document.querySelector<HTMLElement>("[data-testid='save-draft']");
      if (button) flyScheduleChip(button, formatWhen(whenNow.current));
      setFormError(null);
      setDraftId(null);
      setReplyCarry(null);
      setNote("");
      setParts(["", ""]);
      setReply("");
      setContext("");
      setRef("");
      notifySuccess(`Scheduled locally for ${formatWhen(whenNow.current)}, ${localZoneLabel(whenNow.current)}.`);
      window.setTimeout(() => editor.current?.focus(), 0);
    },
    onError: (error) => {
      if (error instanceof ScheduleBusy) return;
      if (error instanceof ScheduleUnknown) {
        setFormError(null);
        return;
      }
      setUnconfirmed(null);
      setFormError(error);
    },
  });
  const keep = useMutation({
    mutationFn: async () => {
      const draft = currentDraft();
      return api<{ id: string }>("/api/drafts", {
        method: "POST",
        body: JSON.stringify({ profileId: profile.id, draft, ...(draftId ? { id: draftId } : {}) }),
      });
    },
    onSuccess: (saved) => {
      setDraftId(saved.id);
      notifySuccess("Saved.");
      void queryClient.invalidateQueries({ queryKey: ["items"] });
      editor.current?.focus();
    },
    onError: (error) => setFormError(error),
  });

  function blankEditor() {
    revision.current += 1;
    setDraftId(null);
    setReplyCarry(null);
    setKind("note");
    setNote("");
    setParts(["", ""]);
    setReply("");
    setRef("");
    setContext("");
    setFormError(null);
    setWhen(Math.floor(Date.now() / 1000) + 60 * 60);
    window.setTimeout(() => editor.current?.focus(), 0);
  }

  function loadDraft(row: DraftRow) {
    const draft = row.draft;
    revision.current += 1;
    setUnconfirmed(null);
    setFormError(null);
    setDraftId(row.id);
    setReplyCarry(null);
    setRef("");
    setContext("");
    if (draft.type === "thread" && draft.segments && draft.segments.length > 0) {
      setKind("thread");
      setParts(draft.segments.map((segment) => segment.content));
      const first = draft.segments[0]?.proposedFireAt;
      if (typeof first === "number") setWhen(first);
      setNote("");
      setReply("");
    } else if (draft.type === "reply") {
      setKind("reply");
      setReply(draft.content ?? "");
      if (typeof draft.proposedFireAt === "number") setWhen(draft.proposedFireAt);
      setNote("");
      setParts(["", ""]);
      if (draft.target) {
        setRef(draft.target.eventId);
        setContext(`${draft.target.eventId}\nby ${draft.target.pubkey}`);
        setReplyCarry({ target: draft.target, ...(draft.parent ? { parent: draft.parent } : {}) });
      }
    } else {
      setKind("note");
      setNote(draft.content ?? "");
      if (typeof draft.proposedFireAt === "number") setWhen(draft.proposedFireAt);
      setParts(["", ""]);
      setReply("");
    }
    window.setTimeout(() => editor.current?.focus(), 0);
  }

  function shownDraft(): Snapshot | null {
    try {
      return currentDraft();
    } catch {
      return null;
    }
  }

  const liveDraft = shownDraft();
  const outcomeShowing = save.isPending || Boolean(formError) || Boolean(unconfirmed && liveDraft && unconfirmed.profileId === profile.id && sameSnapshot(unconfirmed.draft, liveDraft));
  const projection = previewParts(kind === "note" ? { kind: "note", note } : kind === "thread" ? { kind: "thread", parts } : { kind: "reply", reply });

  return (
    <div className="split">
      <section className="write-pane">
        <h1 id={headingId ?? "compose-heading"} tabIndex={-1}>
          {title}
        </h1>
        <div className="tabs" role="group" aria-label="Post kind">
          {(["note", "thread", "reply"] as const).map((value) => (
            <button key={value} type="button" className="tab" aria-pressed={kind === value} data-testid={`kind-${value}`} onClick={() => setKind(value)}>
              {value[0]?.toUpperCase()}
              {value.slice(1)}
            </button>
          ))}
        </div>
        <div className="compose-stage">
          <div className="compose-pair">
            <div className="compose-fields">
              {kind === "note" ? (
                <textarea
                  id="compose-note"
                  ref={editor}
                  className="editor note-lg literata-reading"
                  data-testid="note-text"
                  aria-labelledby={headingId ?? "compose-heading"}
                  aria-invalid={blocked || undefined}
                  aria-describedby={blocked ? "private-key-alert" : undefined}
                  placeholder="Write a note"
                  value={note}
                  onChange={(event) => {
                    revision.current += 1;
                    setNote(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (blocked) return;
                    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && profile.criteriaState !== "invalid") save.mutate();
                  }}
                  />
              ) : null}
              {kind === "thread" ? (
                <div data-testid="thread-editor">
                  {parts.map((part, index) => (
                    <textarea
                      key={index}
                      ref={index === 0 ? editor : undefined}
                      className="editor note-lg literata-reading"
                      data-testid="thread-part"
                      aria-label={index === 0 ? "Root post" : "Reply"}
                      aria-invalid={blocked || undefined}
                      aria-describedby={blocked ? "private-key-alert" : undefined}
                      placeholder={index === 0 ? "Root post" : "Reply"}
                      value={part}
                      onChange={(event) => {
                        revision.current += 1;
                        setParts(parts.map((item, itemIndex) => (itemIndex === index ? event.target.value : item)));
                      }}
                      onKeyDown={(event) => {
                        if (blocked) return;
                        if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && profile.criteriaState !== "invalid") save.mutate();
                      }}
                    />
                  ))}
                  <Button type="button" variant="outline" size="sm" data-testid="add-part" onClick={() => setParts([...parts, ""])}>
                    Add post
                  </Button>
                </div>
              ) : null}
              {kind === "reply" ? (
                <div>
                  <Input label="Note id or nevent" data-testid="note-ref" placeholder="Note id or nevent" value={ref} onChange={(event) => { setReplyCarry(null); setRef(event.target.value); }} />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="load-context"
                    onClick={() => {
                      void api<{ context: string }>("/api/context", { method: "POST", body: JSON.stringify({ profileId: profile.id, ref }) }).then((body) => setContext(body.context));
                    }}
                  >
                    Load thread
                  </Button>
                  {context ? (
                    <pre data-testid="thread-context" className="note-md">
                      {context}
                    </pre>
                  ) : null}
                  <textarea
                    ref={editor}
                    className="editor note-lg literata-reading"
                    data-testid="reply-text"
                    aria-label="Your reply"
                    aria-invalid={blocked || undefined}
                    aria-describedby={blocked ? "private-key-alert" : undefined}
                    placeholder="Your reply"
                    value={reply}
                    onChange={(event) => {
                      revision.current += 1;
                      setReply(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (blocked) return;
                      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && profile.criteriaState !== "invalid") save.mutate();
                    }}
                  />
                </div>
              ) : null}
              {blocked ? (
                <div id="private-key-alert" role="alert" data-testid="private-key-alert" className="error">
                  <p>{pasteWarning}</p>
                </div>
              ) : null}
            </div>
            <aside className="compose-preview" data-testid="compose-preview" aria-label="Preview" hidden={projection.lines.length === 0}>
              {projection.lines.map((line, index) => (
                <p key={index} className="compose-preview-line" data-testid="preview-line">
                  {line}
                </p>
              ))}
            </aside>
          </div>
        </div>
        <div className="composer-foot">
          <div className="composer-meta" role="group" aria-label="When and length">
            <span className="meta-pair">
              <span className="meta-name">When</span>
              <WhenField value={when} onChange={(next) => { revision.current += 1; setWhen(next); }} invalid={Boolean(formError)} />
            </span>
            <span className="meta-pair">
              <span className="meta-name">Count</span>
              <span className="char-count" aria-live={text.length > 280 ? "polite" : "off"} aria-label={`${text.length} of 280 characters`}>
                {text.length} / 280
              </span>
            </span>
          </div>
          {profile.criteriaState === "invalid" ? (
            <div className="error" role="alert" data-testid="repair-note">
              <p>{repairCopy}</p>
              <Button type="button" variant="primary" data-testid="repair-profile" onClick={() => onRepair?.()}>
                Repair profile
              </Button>
            </div>
          ) : null}
          {profile.criteriaState === "absent" && !outcomeShowing ? (
            <p className="field-note" data-testid="keep-note">
              {keepCopy}
            </p>
          ) : null}
          {save.isPending ? <p className="schedule-pending" role="status" data-testid="schedule-pending">{pendingCopy}</p> : null}
          {unconfirmed && liveDraft && unconfirmed.profileId === profile.id && sameSnapshot(unconfirmed.draft, liveDraft) && !save.isPending ? (
            <p className="schedule-unknown" role="status" data-testid="schedule-unknown">{unknownCopy}</p>
          ) : null}
          {formError ? <InlineError error={formError} fallback="The note could not be saved. Try again." /> : null}
          <div className="composer-actions">
            <Button type="button" variant="ghost" data-testid="save-note" onClick={() => keep.mutate()} disabled={blocked || keep.isPending || save.isPending}>
              Save without scheduling
            </Button>
            <Button
              type="button"
              variant="primary"
              data-testid="save-draft"
              title={wide && profile.criteriaState !== "invalid" ? "Control or Command and Enter schedules." : undefined}
              onClick={() => save.mutate()}
              disabled={blocked || save.isPending || keep.isPending || profile.criteriaState === "invalid"}
            >
              Schedule
            </Button>
          </div>
        </div>
      </section>
      <aside className="queue-pane" aria-label="Upcoming">
        <section className="drafts-pane" aria-labelledby="drafts-heading" data-testid="drafts-desk">
          <div className="pane-head">
            <h2 id="drafts-heading">Drafts</h2>
            <button type="button" className="text-link" data-testid="new-draft" onClick={blankEditor}>
              New note
            </button>
          </div>
          {drafts.length === 0 && queue.isSuccess ? <p data-testid="drafts-empty">No saved drafts.</p> : null}
          {drafts.length > 0 ? (
            <ul className="draft-list">
              {drafts.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className="draft-row"
                    data-testid="draft-row"
                    data-draft-id={row.id}
                    aria-current={draftId === row.id ? "true" : undefined}
                    onClick={() => loadDraft(row)}
                  >
                    <time dateTime={new Date(row.fireAt * 1000).toISOString()}>
                      <span className="when-unit">{formatQueueWhen(row.fireAt)}</span>
                      <span className="when-unit">{localZoneLabel(row.fireAt)}</span>
                    </time>
                    <span className="q-preview note-md">{row.preview}</span>
                    <StatusMark status="draft" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        <div className="pane-head">
          <h2>Upcoming</h2>
          <button type="button" className="text-link" data-testid="view-queue" onClick={() => onViewQueue?.()}>
            View queue
          </button>
        </div>
        {queue.isPending && !queue.data ? <p data-testid="rail-loading">Loading queue…</p> : null}
        {queueRows.length === 0 && !queue.isPending ? <p>{scheduled.length === 0 ? "No notes in the queue." : "No notes scheduled this week."}</p> : null}
        <div className="rail-summary">
          {queueRows[0] ? (
            <div className="rail-next">
              <p className="sum-count">{upcoming.length} upcoming</p>
              <time>
                {queueRows[0].fireAt[0] ? (
                  <>
                    <span className="when-unit">{formatQueueWhen(queueRows[0].fireAt[0])}</span>
                    <span className="when-unit">{localZoneLabel(queueRows[0].fireAt[0])}</span>
                  </>
                ) : null}
              </time>
              <p className="rail-excerpt">{queueRows[0].preview}</p>
              <StatusMark status={queueRows[0].status} />
            </div>
          ) : null}
        </div>
        <div className="queue-list rail-list">
          {queueRows.map((item) => (
            <article key={item.id} className="q-row" data-testid={item.id === "composer-draft" ? "composer-draft" : undefined}>
              <time>
                {item.fireAt[0] ? (
                  <>
                    <span className="when-unit">{formatQueueWhen(item.fireAt[0])}</span>
                    <span className="when-unit">{localZoneLabel(item.fireAt[0])}</span>
                  </>
                ) : null}
              </time>
              <p className="q-preview note-md">{item.preview}</p>
              <StatusMark status={item.status} />
            </article>
          ))}
        </div>
      </aside>
    </div>
  );
}

function contextTarget(context: string, ref: string): string {
  const id = /[0-9a-f]{64}/.exec(context)?.[0] ?? /[0-9a-f]{64}/.exec(ref)?.[0] ?? "";
  const pubkey = /by ([0-9a-f]{64})/.exec(context)?.[1] ?? "0".repeat(64);
  return JSON.stringify({ eventId: id, rootId: id, pubkey });
}
