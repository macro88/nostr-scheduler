import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api, type Profile } from "../api";
import { Button, Input, Textarea } from "../components/ui";
import { formatWhen } from "../format";
import { InlineError } from "../states";
import { useToasts } from "../toasts";

type Kind = "note" | "thread" | "reply";

function localValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function Composer({ profile }: { profile: Profile }) {
  const queryClient = useQueryClient();
  const toasts = useToasts();
  const editor = useRef<HTMLTextAreaElement>(null);
  const soon = new Date(Date.now() + 60 * 60 * 1000);
  const [kind, setKind] = useState<Kind>("note");
  const [when, setWhen] = useState(localValue(soon));
  const [note, setNote] = useState("");
  const [parts, setParts] = useState(["", ""]);
  const [ref, setRef] = useState("");
  const [context, setContext] = useState("");
  const [reply, setReply] = useState("");
  const [formError, setFormError] = useState<unknown>(null);
  const fireAt = Math.floor(new Date(when).getTime() / 1000);
  const title = kind === "thread" ? "Write a thread" : kind === "reply" ? "Write a reply" : "Write a note";

  const save = useMutation({
    mutationFn: async () => {
      if (!Number.isFinite(fireAt) || fireAt <= Math.floor(Date.now() / 1000)) {
        throw new Error("created_at in the past");
      }
      if (fireAt > Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60) {
        throw new Error("further ahead than the sign-ahead horizon");
      }
      const draft =
        kind === "note"
          ? { type: "note", content: note, proposedFireAt: fireAt }
          : kind === "thread"
            ? {
                type: "thread",
                segments: parts.map((content, index) => ({ content, proposedFireAt: fireAt + index })),
              }
            : {
                type: "reply",
                content: reply,
                proposedFireAt: fireAt,
                target: JSON.parse(contextTarget(context, ref)),
              };
      return api("/api/compose", { method: "POST", body: JSON.stringify({ profileId: profile.id, draft }) });
    },
    onSuccess: () => {
      setFormError(null);
      setNote("");
      setParts(["", ""]);
      setReply("");
      setContext("");
      setRef("");
      toasts.push({ kind: "success", message: `Scheduled for ${formatWhen(fireAt)}.` });
      void queryClient.invalidateQueries({ queryKey: ["items"] });
      window.setTimeout(() => editor.current?.focus(), 0);
    },
    onError: (error) => setFormError(error),
  });

  return (
    <section data-testid="composer" className="max-w-2xl">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-[#5c564c]">Control and Enter schedules.</p>
      <div className="mt-4 flex gap-2" role="tablist" aria-label="Post kind">
        {(["note", "thread", "reply"] as const).map((value) => (
          <Button
            key={value}
            role="tab"
            aria-selected={kind === value}
            data-testid={`kind-${value}`}
            variant={kind === value ? "default" : "outline"}
            onClick={() => setKind(value)}
            onKeyDown={(event) => {
              const order: Kind[] = ["note", "thread", "reply"];
              const current = order.indexOf(kind);
              if (event.key === "ArrowRight") setKind(order[(current + 1) % order.length] ?? "note");
              if (event.key === "ArrowLeft") setKind(order[(current + order.length - 1) % order.length] ?? "note");
            }}
          >
            {value[0]?.toUpperCase()}
            {value.slice(1)}
          </Button>
        ))}
      </div>
      <label className="mt-6 block text-sm text-[#5c564c]">
        Scheduled time
        <Input data-testid="schedule" className="mt-2" type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} />
        <span className="mt-2 block">{Number.isFinite(fireAt) ? formatWhen(fireAt) : "Choose a time"}</span>
      </label>
      {kind === "note" ? (
        <div className="mt-4">
          <Textarea
            ref={editor}
            data-testid="note-text"
            aria-label="Note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Write a short note"
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") save.mutate();
            }}
          />
          <Count value={note} />
        </div>
      ) : null}
      {kind === "thread" ? (
        <div className="mt-4 space-y-4" data-testid="thread-editor">
          {parts.map((part, index) => (
            <div key={index}>
              <Textarea
                ref={index === 0 ? editor : undefined}
                aria-label={index === 0 ? "Root post" : "Reply"}
                data-testid="thread-part"
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") save.mutate();
                }}
                value={part}
                placeholder={index === 0 ? "Root post" : "Reply"}
                onChange={(event) => setParts(parts.map((item, itemIndex) => (itemIndex === index ? event.target.value : item)))}
              />
              <Count value={part} />
            </div>
          ))}
          <Button variant="outline" data-testid="add-part" onClick={() => setParts([...parts, ""])}>
            Add post
          </Button>
        </div>
      ) : null}
      {kind === "reply" ? (
        <div className="mt-4 space-y-4">
          <Input data-testid="note-ref" aria-label="Note id or nevent" value={ref} placeholder="Note id or nevent" onChange={(event) => setRef(event.target.value)} />
          <Button
            variant="outline"
            data-testid="load-context"
            onClick={() => {
              void api<{ context: string }>("/api/context", {
                method: "POST",
                body: JSON.stringify({ profileId: profile.id, ref }),
              }).then((body) => setContext(body.context));
            }}
          >
            Load thread
          </Button>
          {context ? (
            <pre data-testid="thread-context" className="whitespace-pre-wrap rounded-2xl bg-white p-4 text-sm text-[#3f3a32]">
              {context}
            </pre>
          ) : null}
          <Textarea
            ref={editor}
            data-testid="reply-text"
            aria-label="Your reply"
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            placeholder="Your reply"
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") save.mutate();
            }}
          />
          <Count value={reply} />
        </div>
      ) : null}
      <div className="mt-6 flex items-center gap-3">
        <Button data-testid="save-draft" onClick={() => save.mutate()} disabled={save.isPending}>
          Schedule
        </Button>
        {formError ? <InlineError error={formError} /> : null}
      </div>
    </section>
  );
}

function Count({ value }: { value: string }) {
  return (
    <p className={`mt-1 text-right text-xs ${value.length > 280 ? "text-[#8a4b12]" : "text-[#5c564c]"}`} aria-live={value.length > 280 ? "polite" : "off"}>
      {value.length} / 280
    </p>
  );
}

function contextTarget(context: string, ref: string): string {
  const id = /[0-9a-f]{64}/.exec(context)?.[0] ?? /[0-9a-f]{64}/.exec(ref)?.[0] ?? "";
  const pubkey = /by ([0-9a-f]{64})/.exec(context)?.[1] ?? "0".repeat(64);
  return JSON.stringify({ eventId: id, rootId: id, pubkey });
}
