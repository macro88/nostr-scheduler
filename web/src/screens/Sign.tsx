import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api, signWithBrowser, type Nip46Info, type Profile } from "../api";
import { Button, Input } from "../components/ui";

export function Sign({ profile }: { profile: Profile }) {
  const queryClient = useQueryClient();
  const info = useQuery({
    queryKey: ["nip46", profile.id],
    queryFn: () => api<Nip46Info>(`/api/nip46?profileId=${profile.id}`),
  });
  const [bunkerUri, setBunkerUri] = useState("");
  const [svg, setSvg] = useState("");
  const [status, setStatus] = useState("Idle");
  useEffect(() => {
    const value = info.data?.connectUri;
    if (!value) return;
    void QRCode.toString(value, { type: "svg", margin: 1, width: 180 }).then(setSvg);
  }, [info.data?.connectUri]);

  const browser = useMutation({
    mutationFn: () => signWithBrowser(profile.id),
    onSuccess: (count) => {
      setStatus(`Queued ${count}`);
      void queryClient.invalidateQueries();
    },
    onError: (error: Error) => setStatus(error.message),
  });
  const bunker = useMutation({
    mutationFn: () => api<{ count: number }>("/api/sign/nip46", { method: "POST", body: JSON.stringify({ profileId: profile.id }) }),
    onSuccess: (body) => {
      setStatus(`Bunker signed ${body.count}`);
      void queryClient.invalidateQueries();
    },
    onError: (error: Error) => setStatus(error.message),
  });
  const pair = useMutation({
    mutationFn: () => api("/api/nip46/pair", { method: "POST", body: JSON.stringify({ profileId: profile.id, bunkerUri }) }),
    onSuccess: () => {
      setStatus("Paired");
      void queryClient.invalidateQueries();
    },
    onError: (error: Error) => setStatus(error.message),
  });
  const disconnect = useMutation({
    mutationFn: () => api("/api/nip46/disconnect", { method: "POST", body: JSON.stringify({ profileId: profile.id }) }),
    onSuccess: () => {
      setStatus("Disconnected");
      void queryClient.invalidateQueries();
    },
  });

  return (
    <section data-testid="sign" className="grid gap-6 md:grid-cols-[1.2fr_0.8fr]">
      <div className="rounded-3xl bg-white p-6">
        <h2 className="text-xl font-semibold">Sign</h2>
        <p className="mt-2 text-sm text-[#6d675d]">Approved notes are signed here. A thread is signed root first, with each time left as scheduled.</p>
        <p className="mt-4 text-sm" data-testid="sign-status">
          {browser.isPending || bunker.isPending ? "Waiting for the signer" : status}
        </p>
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
        <p className="mt-2 text-sm text-[#6d675d]">Paste a bunker link, or let the signer scan this code. Disconnect removes the session from this machine.</p>
        <div className="mt-4" data-testid="pair-qr" dangerouslySetInnerHTML={{ __html: svg }} />
        <Input data-testid="bunker-uri" className="mt-4" placeholder="bunker://…" value={bunkerUri} onChange={(event) => setBunkerUri(event.target.value)} />
        <div className="mt-3 flex gap-2">
          <Button data-testid="pair" onClick={() => pair.mutate()} disabled={!bunkerUri.trim() || pair.isPending}>
            Pair
          </Button>
          <Button data-testid="disconnect" variant="outline" onClick={() => disconnect.mutate()}>
            Disconnect
          </Button>
        </div>
        <p className="mt-3 text-sm text-[#6d675d]" data-testid="pair-state">
          {info.data?.paired ? "Paired" : "Not paired"} · {info.data?.request ?? "idle"}
        </p>
      </div>
    </section>
  );
}
