import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { api, type Item, type Profile } from "../api";
import { formatQueueWhen, formatWhen, startOfWeek } from "../format";
import { statusWord } from "../labels";
import { InlineError } from "../states";
import { useToasts } from "../toasts";
import { flyScheduleChip, showCheck } from "../theme/motion";
import { WhenField } from "../WhenField";

type Kind = "note" | "thread" | "reply";

export function Composer({ profile }: { profile: Profile }) {
  const queryClient = useQueryClient();
  const toasts = useToasts();
  const editor = useRef<HTMLTextAreaElement>(null);
  const [kind, setKind] = useState<Kind>("note");
  const [when, setWhen] = useState(() => Math.floor(Date.now() / 1000) + 60 * 60);
  const [note, setNote] = useState("");
  const [parts, setParts] = useState(["", ""]);
  const [ref, setRef] = useState("");
  const [context, setContext] = useState("");
  const [reply, setReply] = useState("");
  const [formError, setFormError] = useState<unknown>(null);
  const queue = useQuery({
    queryKey: ["items", profile.id],
    queryFn: () => api<Item[]>(`/api/items?profileId=${profile.id}`),
  });
  const weekStart = Math.floor(startOfWeek(new Date()).getTime() / 1000);
  const weekEnd = weekStart + 7 * 24 * 60 * 60;
  const upcoming = (queue.data ?? [])
    .filter((item) => ["suggestion", "approved", "signed", "queued", "sent", "failed", "missed"].includes(item.status))
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

  const save = useMutation({
    mutationFn: async () => {
      const fireAt = when;
      if (!Number.isFinite(fireAt) || fireAt <= Math.floor(Date.now() / 1000)) throw new Error("created_at in the past");
      if (fireAt > Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60) throw new Error("further ahead than the sign-ahead horizon");
      const draft =
        kind === "note"
          ? { type: "note", content: note, proposedFireAt: fireAt }
          : kind === "thread"
            ? { type: "thread", segments: parts.map((content, index) => ({ content, proposedFireAt: fireAt + index })) }
            : { type: "reply", content: reply, proposedFireAt: fireAt, target: JSON.parse(contextTarget(context, ref)) };
      return api("/api/compose", { method: "POST", body: JSON.stringify({ profileId: profile.id, draft }) });
    },
    onSuccess: () => {
      const button = document.querySelector<HTMLElement>("[data-testid='save-draft']");
      if (button) {
        showCheck(button);
        flyScheduleChip(button, formatWhen(when));
      }
      setFormError(null);
      setNote("");
      setParts(["", ""]);
      setReply("");
      setContext("");
      setRef("");
      toasts.push({ kind: "success", message: `Scheduled for ${formatWhen(when)}.` });
      void queryClient.invalidateQueries({ queryKey: ["items"] });
      window.setTimeout(() => editor.current?.focus(), 0);
    },
    onError: (error) => setFormError(error),
  });
  const keep = useMutation({
    mutationFn: async () => {
      const draft = kind === "note" ? { type: "note", content: note, proposedFireAt: when } : { type: "note", content: text, proposedFireAt: when };
      return api("/api/suggestions", { method: "POST", body: JSON.stringify({ profileId: profile.id, rationale: "saved from the composer", draft }) });
    },
    onSuccess: () => {
      setNote("");
      setParts(["", ""]);
      setReply("");
      toasts.push({ kind: "success", message: "Saved to the inbox." });
      void queryClient.invalidateQueries({ queryKey: ["items"] });
      editor.current?.focus();
    },
    onError: (error) => setFormError(error),
  });

  return (
    <div className="split">
      <section className="write-pane">
        <h1 id="section-title" tabIndex={-1}>
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
          <textarea
            ref={editor}
            className="editor note-lg"
            data-testid="note-text"
            aria-label="Note"
            placeholder="Write a short note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") save.mutate();
            }}
          />
        ) : null}
        {kind === "thread" ? (
          <div data-testid="thread-editor">
            {parts.map((part, index) => (
              <textarea
                key={index}
                ref={index === 0 ? editor : undefined}
                className="editor note-lg"
                data-testid="thread-part"
                aria-label={index === 0 ? "Root post" : "Reply"}
                placeholder={index === 0 ? "Root post" : "Reply"}
                value={part}
                onChange={(event) => setParts(parts.map((item, itemIndex) => (itemIndex === index ? event.target.value : item)))}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") save.mutate();
                }}
              />
            ))}
            <button type="button" className="btn btn-outline btn-sm" data-testid="add-part" onClick={() => setParts([...parts, ""])}>
              Add post
            </button>
          </div>
        ) : null}
        {kind === "reply" ? (
          <div>
            <input className="field" data-testid="note-ref" aria-label="Note id or nevent" placeholder="Note id or nevent" value={ref} onChange={(event) => setRef(event.target.value)} />
            <button
              type="button"
              className="btn btn-outline btn-sm"
              data-testid="load-context"
              onClick={() => {
                void api<{ context: string }>("/api/context", { method: "POST", body: JSON.stringify({ profileId: profile.id, ref }) }).then((body) => setContext(body.context));
              }}
            >
              Load thread
            </button>
            {context ? (
              <pre data-testid="thread-context" className="note-md">
                {context}
              </pre>
            ) : null}
            <textarea
              ref={editor}
              className="editor note-lg"
              data-testid="reply-text"
              aria-label="Your reply"
              placeholder="Your reply"
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") save.mutate();
              }}
            />
          </div>
        ) : null}
        <div className="composer-foot">
          <p className="caption">Control or Command and Enter schedules.</p>
          <div className="composer-meta">
            <WhenField value={when} onChange={setWhen} invalid={Boolean(formError)} />
            <span className="char-count" aria-live={text.length > 280 ? "polite" : "off"}>
              {text.length} / 280
            </span>
          </div>
          {formError ? <InlineError error={formError} fallback="The note could not be saved. Try again." /> : null}
          <div className="composer-actions">
            <button type="button" className="btn btn-ghost" onClick={() => keep.mutate()} disabled={keep.isPending}>
              Save without scheduling
            </button>
            <button type="button" className="btn btn-primary" data-testid="save-draft" onClick={() => save.mutate()} disabled={save.isPending}>
              Schedule
            </button>
          </div>
        </div>
      </section>
      <aside className="queue-pane">
        <div className="pane-head">
          <h2>Queue</h2>
          <p className="page-kicker">{upcoming.length} this week</p>
        </div>
        <div className="queue-list">
          {upcoming.map((item) => (
            <article key={item.id} className="q-row">
              <time>{item.fireAt[0] ? formatQueueWhen(item.fireAt[0]) : ""}</time>
              <p className="q-preview note-md">{item.preview}</p>
              <StatusWord status={item.status} />
            </article>
          ))}
        </div>
      </aside>
    </div>
  );
}

function StatusWord({ status }: { status: string }) {
  if (status === "failed" || status === "missed") {
    return <span className={`status-flag status-${status}`}>{status === "failed" ? "Failed" : "Missed"}</span>;
  }
  return <span className="status">{statusWord(status)}</span>;
}

function contextTarget(context: string, ref: string): string {
  const id = /[0-9a-f]{64}/.exec(context)?.[0] ?? /[0-9a-f]{64}/.exec(ref)?.[0] ?? "";
  const pubkey = /by ([0-9a-f]{64})/.exec(context)?.[1] ?? "0".repeat(64);
  return JSON.stringify({ eventId: id, rootId: id, pubkey });
}
