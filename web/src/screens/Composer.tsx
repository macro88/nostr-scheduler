import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Input } from "@macro88/ui";
import { api, type Item, type Profile } from "../api";
import { formatQueueWhen, formatWhen, localZoneLabel, startOfWeek } from "../format";
import { StatusMark } from "../status";
import { containsPrivateKey, pasteWarning } from "../../../src/domain/private-key.js";
import { InlineError } from "../states";
import { notifySuccess } from "../toasts";
import { flyScheduleChip, showCheck } from "../theme/motion";
import { WhenField } from "../WhenField";

type Kind = "note" | "thread" | "reply";

const unknownCopy = "This schedule is not confirmed yet. Check the queue, then try again if the note is not there.";

class ScheduleUnknown extends Error {
  constructor() {
    super("unconfirmed");
    this.name = "ScheduleUnknown";
  }
}

type ScheduleAttempt = {
  profileId: string;
  draftId: string | null;
  content: string;
  fireAt: number;
  revision: number;
};

type StoredMatch = { kind: "scheduled" } | { kind: "draft"; id: string } | { kind: "absent" } | { kind: "unread" };

function lostResponse(error: unknown): boolean {
  if (error instanceof ScheduleUnknown) return true;
  if (error instanceof TypeError || error instanceof SyntaxError) return true;
  if (!(error instanceof Error)) return false;
  return /failed to fetch|network|aborted|abort/i.test(error.message);
}

function sameNote(item: Item, attempt: ScheduleAttempt): boolean {
  if (item.profileId !== attempt.profileId) return false;
  if (item.draft?.type === "note" && typeof item.draft.content === "string" && typeof item.draft.proposedFireAt === "number") {
    return item.draft.content === attempt.content && item.draft.proposedFireAt === attempt.fireAt;
  }
  return item.preview === attempt.content && item.fireAt[0] === attempt.fireAt;
}

const scheduledStatus = new Set(["approved", "signed", "queued", "sent"]);

async function readMatch(attempt: ScheduleAttempt): Promise<StoredMatch> {
  try {
    const items = await api<Item[]>(`/api/items?profileId=${attempt.profileId}`);
    const matches = items.filter((item) => sameNote(item, attempt));
    if (matches.some((item) => scheduledStatus.has(item.status))) return { kind: "scheduled" };
    const draft = matches.find((item) => item.status === "draft");
    if (draft) return { kind: "draft", id: draft.id };
    return { kind: "absent" };
  } catch {
    return { kind: "unread" };
  }
}

const repairCopy = "This note has not been scheduled. Repair this profile’s local setup to continue. Your text and chosen time stay here.";
const rulesCopy = "Writing rules for suggestions are not set up. You can still schedule a note you write. A reload clears this box. A saved note stays in the queue until you schedule it.";

export function Composer({ profile, onRepair, headingId }: { profile: Profile; onRepair?: () => void; headingId?: string }) {
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
  const scheduling = useRef(false);
  const revision = useRef(0);
  const noteNow = useRef(note);
  const whenNow = useRef(when);
  noteNow.current = note;
  whenNow.current = when;
  useEffect(() => {
    revision.current += 1;
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
  const weekStart = Math.floor(startOfWeek(new Date()).getTime() / 1000);
  const weekEnd = weekStart + 7 * 24 * 60 * 60;
  const upcoming = (queue.data ?? [])
    .filter((item) => ["draft", "suggestion", "approved", "signed", "queued", "sent", "failed", "missed"].includes(item.status))
    .filter((item) => {
      const at = item.fireAt[0] ?? 0;
      return at >= weekStart && at < weekEnd;
    })
    .sort((left, right) => (left.fireAt[0] ?? 0) - (right.fireAt[0] ?? 0));
  useLayoutEffect(() => {
    const node = editor.current;
    if (!node) return;
    if (!window.matchMedia("(max-width: 800px)").matches) {
      node.style.height = "";
      return;
    }
    node.style.height = "auto";
    node.style.height = `${Math.max(node.scrollHeight, 120)}px`;
    node.scrollTop = 0;
  }, [note, reply, parts, kind]);
  const title = kind === "thread" ? "Write a thread" : kind === "reply" ? "Write a reply" : "Write a note";
  const text = kind === "note" ? note : kind === "reply" ? reply : parts[0] ?? "";
  const texts = kind === "note" ? [note] : kind === "reply" ? [reply] : parts;
  const blocked = texts.some((value) => containsPrivateKey(value));
  const draftText = text.trim();
  const matchesSaved = upcoming.some((item) => item.status === "draft" && item.preview === draftText && item.fireAt[0] === when);
  const queueRows = draftText && !blocked && !matchesSaved
    ? [...upcoming, { id: "composer-draft", fireAt: [when], preview: draftText, status: "suggestion" }].sort(
        (left, right) => (left.fireAt[0] ?? 0) - (right.fireAt[0] ?? 0),
      )
    : upcoming;

  function currentDraft() {
    const fireAt = when;
    if (!Number.isFinite(fireAt) || fireAt <= Math.floor(Date.now() / 1000)) throw new Error("created_at in the past");
    if (fireAt > Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60) throw new Error("further ahead than the sign-ahead horizon");
    if (texts.some((value) => containsPrivateKey(value))) throw new Error(pasteWarning);
    if (kind === "note") return { type: "note", content: note, proposedFireAt: fireAt };
    if (kind === "thread") return { type: "thread", segments: parts.map((content, index) => ({ content, proposedFireAt: fireAt + index })) };
    return { type: "reply", content: reply, proposedFireAt: fireAt, target: JSON.parse(contextTarget(context, ref)) };
  }

  const save = useMutation({
    mutationFn: async () => {
      if (scheduling.current || profile.criteriaState === "invalid") throw new Error(repairCopy);
      const attempt: ScheduleAttempt = {
        profileId: profile.id,
        draftId,
        content: note,
        fireAt: when,
        revision: revision.current,
      };
      if (unconfirmed && unconfirmed.profileId === attempt.profileId && unconfirmed.content === attempt.content && unconfirmed.fireAt === attempt.fireAt) {
        const found = await readMatch(unconfirmed);
        if (found.kind === "scheduled") return { id: unconfirmed.draftId ?? "reconciled", attempt };
        if (found.kind === "unread") throw new ScheduleUnknown();
        if (found.kind === "draft") {
          try {
            const approved = await api<{ id: string }>(`/api/items/${found.id}/approve`, { method: "POST", body: "{}" });
            return { ...approved, attempt: { ...attempt, draftId: found.id } };
          } catch (error) {
            const again = await readMatch({ ...attempt, draftId: found.id });
            if (again.kind === "scheduled") return { id: found.id, attempt };
            if (again.kind === "unread" || lostResponse(error)) {
              setUnconfirmed({ ...attempt, draftId: found.id });
              throw new ScheduleUnknown();
            }
            throw error;
          }
        }
      }
      const draft = currentDraft();
      scheduling.current = true;
      try {
        if (draftId) {
          await api(`/api/drafts`, { method: "POST", body: JSON.stringify({ profileId: profile.id, id: draftId, draft }) });
          const approved = await api<{ id: string }>(`/api/items/${draftId}/approve`, { method: "POST", body: "{}" });
          return { ...approved, attempt: { ...attempt, draftId } };
        }
        const created = await api<{ id: string }>("/api/compose", { method: "POST", body: JSON.stringify({ profileId: profile.id, draft }) });
        return { ...created, attempt: { ...attempt, draftId: created.id } };
      } catch (error) {
        const found = await readMatch(attempt);
        if (found.kind === "scheduled") return { id: attempt.draftId ?? "reconciled", attempt };
        if (lostResponse(error) || found.kind === "unread") {
          setUnconfirmed(found.kind === "draft" ? { ...attempt, draftId: found.id } : attempt);
          throw new ScheduleUnknown();
        }
        throw error;
      } finally {
        scheduling.current = false;
      }
    },
    onSuccess: (result) => {
      const attempt = result.attempt;
      setUnconfirmed((current) => (current && current.revision === attempt.revision ? null : current));
      const same = attempt.revision === revision.current && attempt.profileId === profile.id && attempt.content === noteNow.current && attempt.fireAt === whenNow.current;
      void queryClient.invalidateQueries({ queryKey: ["items"] });
      if (!same) return;
      const button = document.querySelector<HTMLElement>("[data-testid='save-draft']");
      if (button) {
        showCheck(button);
        flyScheduleChip(button, formatWhen(whenNow.current));
      }
      setFormError(null);
      setDraftId(null);
      setNote("");
      setParts(["", ""]);
      setReply("");
      setContext("");
      setRef("");
      notifySuccess(`Scheduled locally for ${formatWhen(whenNow.current)}, ${localZoneLabel(whenNow.current)}.`);
      window.setTimeout(() => editor.current?.focus(), 0);
    },
    onError: (error) => {
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

  return (
    <div className="split">
      <section className="write-pane">
        <h1 {...(headingId ? { id: headingId } : {})} tabIndex={-1}>
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
        {kind === "note" ? (
          <>
            <label className="editor-label" htmlFor="compose-note">Note</label>
            <textarea
              id="compose-note"
              ref={editor}
            className="editor note-lg literata-reading"
            data-testid="note-text"
            aria-label="Note"
            aria-invalid={blocked || undefined}
            aria-describedby={blocked ? "private-key-alert" : undefined}
            placeholder="Write a short note"
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
          </>
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
            <Input label="Note id or nevent" data-testid="note-ref" placeholder="Note id or nevent" value={ref} onChange={(event) => setRef(event.target.value)} />
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
        <div className="composer-foot">
          <div className="composer-meta">
            <WhenField value={when} onChange={(next) => { revision.current += 1; setWhen(next); }} invalid={Boolean(formError)} />
            <span className="char-count" aria-live={text.length > 280 ? "polite" : "off"}>
              {text.length} / 280
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
          {profile.criteriaState === "absent" ? (
            <p className="field-note" data-testid="writing-rules-note">
              {rulesCopy}
            </p>
          ) : null}
          {unconfirmed ? <p className="schedule-unknown" role="status" data-testid="schedule-unknown">{unknownCopy}</p> : null}
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
      <aside className="queue-pane">
        <div className="pane-head">
          <h2>Queue</h2>
          <p className="page-kicker">{upcoming.length} this week</p>
        </div>
        <div className="queue-list">
          {queueRows.map((item) => (
            <article key={item.id} className="q-row" data-testid={item.id === "composer-draft" ? "composer-draft" : undefined}>
              <time>{item.fireAt[0] ? `${formatQueueWhen(item.fireAt[0])} ${localZoneLabel(item.fireAt[0])}` : ""}</time>
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
