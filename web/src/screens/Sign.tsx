import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api, signWithBrowser, type Item, type Nip46Info, type Profile } from "../api";
import { Button, Input } from "../components/ui";
import { plainError } from "../errors";
import { formatWhen } from "../format";
import { usePendingSurface } from "../pending";
import { EmptyState, InlineError, LoadingBlock } from "../states";
import { useToasts } from "../toasts";

export function Sign({ profile }: { profile: Profile }) {
  const queryClient = useQueryClient();
  const toasts = useToasts();
  const items = useQuery({
    queryKey: ["items", profile.id],
    queryFn: () => api<Item[]>(`/api/items?profileId=${profile.id}`),
  });
  const waiting = (items.data ?? []).filter((item) => item.status === "approved");
  const steps = waiting.reduce((total, item) => total + (item.draft?.type === "thread" ? (item.draft.segments?.length ?? 1) : 1), 0);
  const surface = usePendingSurface(items.isPending && !items.data);
  const info = useQuery({
    queryKey: ["nip46", profile.id],
    queryFn: () => api<Nip46Info>(`/api/nip46?profileId=${profile.id}`),
  });
  const [bunkerUri, setBunkerUri] = useState("");
  const [svg, setSvg] = useState("");
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
      }),
    onSuccess: (count) => {
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

  return (
    <section data-testid="sign" aria-label="Sign" className="grid gap-6 md:grid-cols-[1.2fr_0.8fr]">
      <div className="rounded-3xl bg-white p-6">
        <p className="text-sm text-[#5c564c]">Approved notes are signed here. A thread is signed root first, with each time left as scheduled.</p>
        <p className="mt-4 text-sm" data-testid="sign-status" role="status">
          {browser.isPending || bunker.isPending
            ? steps > 1
              ? `Waiting for the signer. ${step} of ${steps}`
              : "Waiting for the signer"
            : status || (waiting.length > 0 ? `${waiting.length} waiting to be signed.` : "")}
        </p>
        {items.isPending && !items.data && !surface.loading ? <p className="sr-only">Loading notes to sign</p> : null}
        <LoadingBlock pending={surface.loading} label="Loading notes to sign" />
        {surface.ready && !items.isError && waiting.length === 0 ? <EmptyState title="Nothing is waiting to be signed." /> : null}
        <ul className="mt-4 space-y-2" aria-label="Notes waiting to be signed">
          {waiting.map((item) => (
            <li key={item.id} className="rounded-2xl bg-[#f7f4ee] p-3 text-sm">
              <span>{item.fireAt[0] ? formatWhen(item.fireAt[0]) : ""}</span>
              <p>{item.preview}</p>
            </li>
          ))}
        </ul>
        {items.isError ? <InlineError error={items.error} fallback="The notes could not be loaded. Try again." /> : null}
        {browser.error || bunker.error || pair.error ? <InlineError error={browser.error ?? bunker.error ?? pair.error} /> : null}
        <div className="mt-6 flex flex-wrap gap-2">
          <Button data-testid="sign-browser" onClick={() => browser.mutate()} disabled={browser.isPending}>
            Sign with browser
          </Button>
          <Button data-testid="sign-bunker" variant="outline" onClick={() => bunker.mutate()} disabled={!info.data?.paired || bunker.isPending}>
            Sign with bunker
          </Button>
        </div>
      </div>
      <div className="rounded-3xl bg-white p-6">
        <h3 className="font-semibold">Bunker</h3>
        <p className="mt-2 text-sm text-[#5c564c]">Paste a bunker link, or let the signer scan this code. Disconnect removes the session from this machine.</p>
        <div
          className="mt-4"
          data-testid="pair-qr"
          role={svg ? "img" : undefined}
          aria-label={svg ? "Code for pairing a bunker" : undefined}
          dangerouslySetInnerHTML={{ __html: svg.replace("<svg", '<svg aria-hidden="true" focusable="false"') }}
        />
        <Input data-testid="bunker-uri" aria-label="Bunker link" className="mt-4" placeholder="bunker://…" value={bunkerUri} onChange={(event) => setBunkerUri(event.target.value)} />
        <div className="mt-3 flex gap-2">
          <Button data-testid="pair" onClick={() => pair.mutate()} disabled={!bunkerUri.trim() || pair.isPending}>
            Pair
          </Button>
          <Button data-testid="disconnect" variant="outline" onClick={() => disconnect.mutate()}>
            Disconnect
          </Button>
        </div>
        <p className="mt-3 text-sm text-[#5c564c]" data-testid="pair-state">
          {info.data?.paired ? "Paired" : "Not paired"} · {info.data?.request ?? "idle"}
        </p>
      </div>
    </section>
  );
}
