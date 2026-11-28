import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@macro88/ui";
import { api, type Profile } from "../api";
import { researchText } from "../../../src/domain/research-text.js";
import { containsPrivateKey, pasteWarning } from "../../../src/domain/private-key.js";
import { previewParts } from "../preview";
import { readResearchHits, type ResearchHit } from "../research";
import { InlineError, LoadingBlock } from "../states";
import { notifySuccess } from "../toasts";
import { WhenField } from "../WhenField";

function kindLabel(kind: ResearchHit["kind"]): string {
  switch (kind) {
    case "outlier":
      return "Outlier";
    case "source":
      return "Source";
    case "brief":
      return "Brief";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function rowTitle(hit: ResearchHit): string {
  const line = (researchText(hit).split("\n", 1)[0] ?? "").replace(/\s+/g, " ").trim();
  const excerpt = line.length > 72 ? `${line.slice(0, 71)}…` : line;
  if (hit.kind === "outlier") return `${hit.multiplier}× ${excerpt}`;
  return excerpt;
}

export function Remix({ profile, onCompose, headingId }: { profile: Profile; onCompose: () => void; headingId?: string }) {
  const queryClient = useQueryClient();
  const editor = useRef<HTMLTextAreaElement>(null);
  const copyTimer = useRef<number | null>(null);
  const lastCopy = useRef("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [draftIds, setDraftIds] = useState<Record<string, string>>({});
  const [when, setWhen] = useState(() => Math.floor(Date.now() / 1000) + 60 * 60);
  const [localError, setLocalError] = useState<string | null>(null);
  const [formError, setFormError] = useState<unknown>(null);
  const [copyMessage, setCopyMessage] = useState("");
  const research = useQuery({
    queryKey: ["research", profile.id],
    queryFn: async () => readResearchHits(await api<unknown>(`/api/research?profileId=${profile.id}`)),
  });
  const hits = research.data ?? [];
  const selected = hits.find((hit) => hit.id === selectedId) ?? null;
  const note = selected ? (edits[selected.id] ?? researchText(selected)) : "";
  const blocked = containsPrivateKey(note);
  const projection = previewParts({ kind: "note", note });

  useEffect(() => {
    setSelectedId(null);
    setEdits({});
    setDraftIds({});
    setLocalError(null);
    setFormError(null);
    setCopyMessage("");
  }, [profile.id]);

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  useLayoutEffect(() => {
    if (!selectedId) return;
    const source = document.querySelector("[data-testid='source-text']");
    if (performance.getEntriesByName("remix-open-start").length > 0 && source instanceof HTMLElement && source.textContent) {
      performance.mark("remix-open-paint");
      performance.measure("remix-open", "remix-open-start", "remix-open-paint");
      const entry = performance.getEntriesByName("remix-open").at(-1);
      if (entry) source.dataset.openMs = String(entry.duration);
      performance.clearMarks("remix-open-start");
    }
    editor.current?.focus();
  }, [selectedId]);

  const save = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("Pick a research note first.");
      const draftId = draftIds[selected.id];
      const saved = await api<{ id: string; status: string }>("/api/drafts", {
        method: "POST",
        body: JSON.stringify({
          profileId: profile.id,
          draft: { type: "note", content: note, proposedFireAt: when },
          ...(draftId ? { id: draftId } : {}),
        }),
      });
      if (saved.status !== "draft") throw new Error("The note was not saved as a draft.");
      await api(`/api/research/${selected.id}/remix`, { method: "POST", body: "{}" });
      return saved;
    },
    onSuccess: (saved) => {
      if (!selected) return;
      setDraftIds((current) => ({ ...current, [selected.id]: saved.id }));
      setFormError(null);
      setLocalError(null);
      notifySuccess("Saved to drafts.");
      void queryClient.invalidateQueries({ queryKey: ["research", profile.id] });
      void queryClient.invalidateQueries({ queryKey: ["items", profile.id] });
      editor.current?.focus();
    },
    onError: (error) => setFormError(error),
  });

  function selectHit(id: string) {
    performance.mark("remix-open-start");
    setSelectedId(id);
    setLocalError(null);
    setFormError(null);
  }

  function reportCopy(message: string) {
    let next = message;
    if (next === lastCopy.current) next += "\u00A0";
    lastCopy.current = next;
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    setCopyMessage("");
    window.requestAnimationFrame(() => setCopyMessage(next));
    copyTimer.current = window.setTimeout(() => {
      setCopyMessage("");
      copyTimer.current = null;
    }, 2000);
  }

  async function copyRemix() {
    if (note.trim() === "") {
      reportCopy("Write the note first.");
      return;
    }
    try {
      await navigator.clipboard.writeText(note);
      reportCopy("Copied");
    } catch {
      reportCopy("Copy failed");
    }
  }

  function openCompose() {
    if (!selected || !draftIds[selected.id]) {
      setLocalError("Save to drafts first.");
      return;
    }
    onCompose();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    if (note.trim() === "") {
      setLocalError("Write the note before saving.");
      editor.current?.focus();
      return;
    }
    if (blocked) {
      editor.current?.focus();
      return;
    }
    setLocalError(null);
    save.mutate();
  }

  return (
    <div className="remix-layout" data-testid="remix">
      <h1 id={headingId ?? "remix-heading"} tabIndex={-1}>
        Remix
      </h1>
      <p className="page-kicker">Save to drafts. Scheduling stays in Compose.</p>
      <LoadingBlock pending={research.isPending && !research.data} label="Loading research notes" />
      {research.isError ? <InlineError error={research.error} fallback="Research notes could not be loaded. Try again." /> : null}
      {research.isSuccess && hits.length === 0 ? <p data-testid="research-empty">No research notes for this profile.</p> : null}
      {hits.length > 0 ? (
        <div className="remix-body">
          <div className="remix-list">
            <h2>Notes</h2>
            <ul className="research-list" role="list">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    className="research-row"
                    data-testid="research-row"
                    data-research-id={hit.id}
                    aria-current={hit.id === selectedId ? "true" : undefined}
                    onClick={() => selectHit(hit.id)}
                  >
                    <span className="research-kind">{kindLabel(hit.kind)}</span>
                    <span className="q-preview note-md">{rowTitle(hit)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {selected ? (
            <div className="remix-work">
              <div className="source-pane">
                <h2 id="source-heading">Source</h2>
                <pre id="source-text" className="source-text" data-testid="source-text" tabIndex={0} aria-labelledby="source-heading">
                  {researchText(selected)}
                </pre>
              </div>
              <form className="remix-editor" aria-labelledby="remix-editor-heading" onSubmit={submit} noValidate>
                <h2 id="remix-editor-heading">Your note</h2>
                <div className="compose-stage">
                  <div className="compose-pair">
                    <div className="compose-fields">
                      <label className="sr" htmlFor="remix-text">
                        Your note
                      </label>
                      <textarea
                        id="remix-text"
                        ref={editor}
                        className="editor note-lg literata-reading"
                        data-testid="remix-text"
                        aria-invalid={blocked || Boolean(localError) || undefined}
                        aria-describedby={blocked ? "remix-private-key" : undefined}
                        placeholder="Rewrite it in your voice"
                        value={note}
                        onChange={(event) => {
                          const value = event.target.value;
                          setEdits((current) => ({ ...current, [selected.id]: value }));
                          if (value.trim() !== "") setLocalError(null);
                        }}
                      />
                    </div>
                    <aside className="compose-preview" data-testid="remix-preview" aria-label="Preview" hidden={projection.lines.length === 0}>
                      {projection.lines.map((line, index) => (
                        <p key={index} className="compose-preview-line" data-testid="preview-line">
                          {line}
                        </p>
                      ))}
                    </aside>
                  </div>
                </div>
                {blocked ? (
                  <div id="remix-private-key" role="alert" data-testid="private-key-alert" className="error">
                    <p>{pasteWarning}</p>
                  </div>
                ) : null}
                <div className="composer-foot">
                  <div className="composer-meta" role="group" aria-label="When and length">
                    <span className="meta-pair">
                      <span className="meta-name">When</span>
                      <WhenField value={when} onChange={setWhen} invalid={Boolean(formError)} />
                    </span>
                    <span className="meta-pair">
                      <span className="meta-name">Count</span>
                      <span className="char-count" aria-live={note.length > 280 ? "polite" : "off"} aria-label={`${note.length} of 280 characters`}>
                        {note.length} / 280
                      </span>
                    </span>
                  </div>
                  {localError ? (
                    <p className="error" role="alert" data-testid="remix-error">
                      {localError}
                    </p>
                  ) : null}
                  {formError ? <InlineError error={formError} fallback="The note could not be saved. Try again." /> : null}
                  <div className="composer-actions">
                    <Button type="submit" variant="primary" data-testid="save-remix" disabled={save.isPending}>
                      Save to drafts
                    </Button>
                    <Button type="button" variant="ghost" data-testid="copy-remix" onClick={() => void copyRemix()}>
                      Copy remix
                    </Button>
                    <Button type="button" variant="outline" data-testid="edit-in-compose" onClick={openCompose}>
                      Edit in Compose
                    </Button>
                  </div>
                  <p className="copy-status" role="status" data-testid="copy-status">
                    {copyMessage}
                  </p>
                </div>
              </form>
            </div>
          ) : (
            <p data-testid="remix-pick">Pick a note to read the source and write a remix.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
