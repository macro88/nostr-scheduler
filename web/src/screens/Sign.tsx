import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { EmptyState } from "@macro88/ui";
import { api, signWithBrowser, type Item, type Nip46Info, type Profile } from "../api";
import { plainError } from "../errors";
import { formatQueueWhen } from "../format";
import { usePendingSurface } from "../pending";
import { InlineError, LoadingBlock } from "../states";
import { showCheck } from "../theme/motion";
import { useToasts } from "../toasts";

export function Sign({ profile }: { profile: Profile }) {
  const queryClient = useQueryClient();
  const toasts = useToasts();
  const items = useQuery({
    queryKey: ["items", profile.id],
    queryFn: () => api<Item[]>(`/api/items?profileId=${profile.id}`),
  });
  const waiting = (items.data ?? []).filter((item) => item.status === "approved");
  const waitingKey = waiting.map((item) => item.id).join("|");
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    setSelected(waitingKey ? waitingKey.split("|") : []);
  }, [waitingKey]);
  const chosen = waiting.filter((item) => selected.includes(item.id));
  const steps = chosen.reduce((total, item) => total + (item.draft?.type === "thread" ? (item.draft.segments?.length ?? 1) : 1), 0);
  const allOn = waiting.length > 0 && chosen.length === waiting.length;
  const surface = usePendingSurface(items.isPending && !items.data);
  const info = useQuery({
    queryKey: ["nip46", profile.id],
    queryFn: () => api<Nip46Info>(`/api/nip46?profileId=${profile.id}`),
  });
  const [bunkerUri, setBunkerUri] = useState("");
  const [svg, setSvg] = useState("");
  const [showQr, setShowQr] = useState(false);
  const [status, setStatus] = useState("");
  const [step, setStep] = useState(0);
  useEffect(() => {
    const value = info.data?.connectUri;
    if (!value) return;
    void QRCode.toString(value, { type: "svg", margin: 1, width: 180 }).then(setSvg);
  }, [info.data?.connectUri]);

  const browser = useMutation({
    mutationFn: () =>
      signWithBrowser(profile.id, (index) => {
        setStep(index);
        setStatus(steps > 1 ? `Waiting for the signer. ${index} of ${steps}` : "Waiting for the signer");
      }, selected),
    onSuccess: (count) => {
      const button = document.querySelector<HTMLElement>("[data-testid='sign-browser']");
      if (button) showCheck(button);
      setStatus(`Queued ${count}`);
      toasts.push({ kind: "success", message: `Queued ${count}.` });
      void queryClient.invalidateQueries();
    },
    onError: (error: Error) => {
      const plain = plainError(error);
      setStatus(plain.message);
      toasts.push({ kind: "error", ...plain });
    },
  });
  const bunker = useMutation({
    mutationFn: () => api<{ count: number }>("/api/sign/nip46", { method: "POST", body: JSON.stringify({ profileId: profile.id }) }),
    onSuccess: (body) => {
      setStatus(`Bunker signed ${body.count}`);
      void queryClient.invalidateQueries();
    },
    onError: (error: Error) => {
      const plain = plainError(error);
      setStatus(plain.message);
      toasts.push({ kind: "error", ...plain });
    },
  });
  const pair = useMutation({
    mutationFn: () => api("/api/nip46/pair", { method: "POST", body: JSON.stringify({ profileId: profile.id, bunkerUri }) }),
    onSuccess: () => {
      setStatus("Paired");
      void queryClient.invalidateQueries();
    },
    onError: (error: Error) => {
      const plain = plainError(error);
      setStatus(plain.message);
      toasts.push({ kind: "error", ...plain });
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api("/api/nip46/disconnect", { method: "POST", body: JSON.stringify({ profileId: profile.id }) }),
    onSuccess: () => {
      setStatus("Disconnected");
      void queryClient.invalidateQueries();
    },
  });

  const progress =
    browser.isPending || bunker.isPending
      ? steps > 1
        ? `Waiting for the signer. ${step} of ${steps}`
        : "Waiting for the signer"
      : status;
  return (
    <section data-testid="sign" aria-label="Sign" className="sign-layout">
      <div className="sign-hero">
        <h1 id="section-title" tabIndex={-1}>
          Sign
        </h1>
        <p className="page-kicker">{waiting.length} waiting to be signed</p>
        <p className="sr" data-testid="sign-status" role="status">
          {progress || (waiting.length > 0 ? `${waiting.length} waiting to be signed.` : "")}
        </p>
        {items.isPending && !items.data && !surface.loading ? <p className="sr">Loading notes to sign</p> : null}
        <LoadingBlock pending={surface.loading} label="Loading notes to sign" />
        {surface.ready && !items.isError && waiting.length === 0 ? (
          <div data-testid="empty">
            <EmptyState title="Nothing is waiting to be signed." />
          </div>
        ) : null}
        <div className="work-list">
          {waiting.length > 0 ? (
            <div className="work-head">
              <button
                type="button"
                role="checkbox"
                className={`check${allOn ? " on" : ""}`}
                aria-checked={allOn}
                aria-label="Select all"
                onClick={() => setSelected(allOn ? [] : waiting.map((item) => item.id))}
              >
                {allOn ? <CheckMark /> : null}
              </button>
              <span>Select all</span>
            </div>
          ) : null}
          {waiting.map((item) => {
            const on = selected.includes(item.id);
            return (
              <article key={item.id} className="work-row">
                <button
                  type="button"
                  role="checkbox"
                  className={`check${on ? " on" : ""}`}
                  aria-checked={on}
                  aria-label={`Select ${item.preview}`}
                  onClick={() => setSelected((current) => (current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id]))}
                >
                  {on ? <CheckMark /> : null}
                </button>
                <div>
                  <div className="row-status">
                    <span className="status">Approved</span>
                    <time>{item.fireAt[0] ? formatQueueWhen(item.fireAt[0]) : ""}</time>
                  </div>
                  <p className="note-lg">{item.preview}</p>
                </div>
              </article>
            );
          })}
        </div>
        {items.isError ? <InlineError error={items.error} fallback="The notes could not be loaded. Try again." /> : null}
        {browser.error || bunker.error || pair.error ? <InlineError error={browser.error ?? bunker.error ?? pair.error} /> : null}
        <div className="sign-off">
          <div className="ink-rule" aria-hidden="true" />
          {steps > 1 && (browser.isPending || bunker.isPending) ? (
            <div className="sign-progress" aria-hidden="true">
              <span style={{ transform: `scaleX(${steps === 0 ? 0 : step / steps})` }} />
            </div>
          ) : null}
          <div className="actions">
            <button type="button" className="btn btn-primary" data-testid="sign-browser" onClick={() => browser.mutate()} disabled={browser.isPending || chosen.length === 0}>
              {chosen.length === 1 ? "Sign note" : chosen.length > 1 ? `Sign ${chosen.length} notes` : "Sign notes"}
            </button>
            <button type="button" className="btn btn-outline" data-testid="sign-bunker" onClick={() => bunker.mutate()} disabled={!info.data?.paired || bunker.isPending}>
              Sign with bunker
            </button>
          </div>
        </div>
      </div>
      <aside className="bunker-panel">
        <h2>Bunker</h2>
        <p className="support">Pair a remote signer when you do not want to use the browser. The pairing code stays hidden until you need it.</p>
        <input className="field mono" data-testid="bunker-uri" aria-label="Bunker link" placeholder="bunker://" value={bunkerUri} onChange={(event) => setBunkerUri(event.target.value)} />
        <div className="pair-row">
          <button type="button" className="btn btn-outline btn-sm" data-testid="pair" onClick={() => pair.mutate()} disabled={!bunkerUri.trim() || pair.isPending}>
            Pair
          </button>
          <button type="button" className="btn btn-outline btn-sm" data-testid="disconnect" onClick={() => disconnect.mutate()} disabled={!info.data?.paired || disconnect.isPending}>
            Disconnect
          </button>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => setShowQr((current) => !current)}>
          {showQr ? "Hide pairing QR" : "Show pairing QR"}
        </button>
        {showQr ? (
          <div data-testid="pair-qr" role="img" aria-label="Code for pairing a bunker" dangerouslySetInnerHTML={{ __html: svg.replace("<svg", '<svg aria-hidden="true" focusable="false"') }} />
        ) : null}
        <p className="bunker-status" data-testid="pair-state">
          {info.data?.paired ? "Paired" : "Not paired"}
        </p>
      </aside>
    </section>
  );
}

function CheckMark() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}
