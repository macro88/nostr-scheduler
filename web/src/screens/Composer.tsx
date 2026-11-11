import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Profile } from "../api";
import { Button, Input, Textarea } from "../components/ui";

type Kind = "note" | "thread" | "reply";

function localValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function Composer({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const soon = new Date(Date.now() + 60 * 60 * 1000);
  const [kind, setKind] = useState<Kind>("note");
  const [when, setWhen] = useState(localValue(soon));
  const [note, setNote] = useState("");
  const [parts, setParts] = useState(["", ""]);
  const [ref, setRef] = useState("");
  const [context, setContext] = useState("");
  const [reply, setReply] = useState("");
  const fireAt = Math.floor(new Date(when).getTime() / 1000);

  const save = useMutation({
    mutationFn: async () => {
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
    onSuccess: () => onDone(),
  });

  return (
    <section data-testid="composer" className="max-w-2xl">
      <h2 className="text-xl font-semibold">Compose</h2>
      <div className="mt-4 flex gap-2">
        {(["note", "thread", "reply"] as const).map((value) => (
          <Button key={value} data-testid={`kind-${value}`} variant={kind === value ? "default" : "outline"} onClick={() => setKind(value)}>
            {value}
          </Button>
        ))}
      </div>
      <label className="mt-6 block text-sm text-[#5c564c]">
        Scheduled time
        <Input data-testid="schedule" className="mt-2" type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} />
      </label>
      {kind === "note" ? (
        <div className="mt-4">
          <Textarea data-testid="note-text" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Write a short note" />
          <Count value={note} />
        </div>
      ) : null}
      {kind === "thread" ? (
        <div className="mt-4 space-y-4" data-testid="thread-editor">
          {parts.map((part, index) => (
            <div key={index}>
              <Textarea
                data-testid="thread-part"
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
          <Input data-testid="note-ref" value={ref} placeholder="Note id or nevent" onChange={(event) => setRef(event.target.value)} />
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
          <Textarea data-testid="reply-text" value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Your reply" />
          <Count value={reply} />
        </div>
      ) : null}
      <div className="mt-6 flex items-center gap-3">
        <Button data-testid="save-draft" onClick={() => save.mutate()} disabled={save.isPending}>
          Schedule
        </Button>
        {save.error ? <p className="text-sm text-[#8a2e24]">{save.error.message}</p> : null}
      </div>
    </section>
  );
}

function Count({ value }: { value: string }) {
  return <p className={`mt-1 text-right text-xs ${value.length > 280 ? "text-[#8a4b12]" : "text-[#7a746a]"}`}>{value.length}</p>;
}

function contextTarget(context: string, ref: string): string {
  const id = /[0-9a-f]{64}/.exec(context)?.[0] ?? /[0-9a-f]{64}/.exec(ref)?.[0] ?? "";
  const pubkey = /by ([0-9a-f]{64})/.exec(context)?.[1] ?? "0".repeat(64);
  return JSON.stringify({ eventId: id, rootId: id, pubkey });
}
