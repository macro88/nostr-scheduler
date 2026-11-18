import { useEffect, useRef, useState } from "react";
import { Badge, Button, ConfirmSheet, Input, RadioGroup, Switch } from "@macro88/ui";
import { api, type Profile } from "../api";
import { containsPrivateKey } from "../../../src/domain/private-key.js";
import { isNpub, shortNpub } from "../npub";
import { notifySuccess } from "../toasts";

const secretWarning =
  "That's a private key (nsec). This app never needs it. Paste your npub, and keep your nsec in your signer.";

const steps = [
  { id: "identity", name: "Profile", title: "Your identity" },
  { id: "signer", name: "Signer", title: "Signing method" },
  { id: "local", name: "Local setup", title: "Local setup" },
] as const;

const signerOptions = [
  { value: "nip07", label: "Browser extension", description: "NIP-07" },
  { value: "nip46", label: "Remote signer (bunker)", description: "NIP-46" },
  { value: "nip55", label: "Android app", description: "NIP-55" },
] as const;

type SignerKind = "" | (typeof signerOptions)[number]["value"];
type RelayRow = { url: string; public: boolean; unreachable: boolean };

function loopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "ws:" || url.protocol === "wss:") && ["127.0.0.1", "localhost", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

function signerStatus(kind: SignerKind): string {
  if (kind === "nip07") return "Not connected yet. It will be used later, on Sign.";
  if (kind === "nip46") return "Not paired. You can pair it after this profile is saved.";
  if (kind === "nip55") return "Android app is for a phone. On this computer, choose a browser extension or a remote signer.";
  return "No option is selected yet.";
}

export function FirstRun({ profile, onSaved, onExit }: { profile?: Profile; onSaved: (id: string) => void; onExit?: () => void }) {
  const [step, setStep] = useState(0);
  const [label, setLabel] = useState(profile?.label ?? "");
  const [npub, setNpub] = useState(profile?.npub ?? "");
  const [npubOpen, setNpubOpen] = useState(!profile?.npub);
  const [kind, setKind] = useState<SignerKind>(
    profile?.signer.kind === "nip07" || profile?.signer.kind === "nip46" || profile?.signer.kind === "nip55" ? profile.signer.kind : "",
  );
  const [relays, setRelays] = useState<RelayRow[]>((profile?.relays ?? []).map((item) => ({ url: item.url, public: item.public, unreachable: false })));
  const [relayDraft, setRelayDraft] = useState("");
  const [relayError, setRelayError] = useState("");
  const [readNip65, setReadNip65] = useState(profile?.readNip65 === true);
  const [allowPublic, setAllowPublic] = useState(profile?.allowPublicRelays === true);
  const [askPublic, setAskPublic] = useState(false);
  const [error, setError] = useState("");
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const ticket = useRef(0);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const focusMode = useRef<"title" | "continue" | "error" | "stay">("title");

  useEffect(() => {
    const mode = focusMode.current;
    focusMode.current = "stay";
    if (mode === "continue") continueRef.current?.focus();
    else if (mode === "error") document.getElementById("setup-error")?.focus();
    else if (mode === "title") titleRef.current?.focus();
  }, [step, error]);

  function take(value: string, apply: (next: string) => void, field: string) {
    if (containsPrivateKey(value)) {
      apply("");
      setSecret(field);
      setError("");
      return;
    }
    if (secret === field) setSecret("");
    apply(value);
  }

  function identityError(): string {
    if (!label.trim()) return "Enter a profile name.";
    if (!npub.trim()) return "Paste an npub starting with npub1.";
    if (/^[0-9a-fA-F]{64}$/.test(npub.trim())) return "That looks like a hex key. Paste the npub instead.";
    if (!isNpub(npub.trim())) return "That isn't an npub. It starts with npub1.";
    return "";
  }

  function continueFrom(index: number) {
    if (index === 0) {
      const problem = identityError();
      if (problem) {
        setError(problem);
        focusMode.current = "error";
        return;
      }
    }
    if (index === 1 && !kind) {
      setError("Choose a signing method.");
      focusMode.current = "error";
      return;
    }
    setError("");
    setSecret("");
    focusMode.current = "title";
    setStep(index + 1);
  }

  function back() {
    ticket.current += 1;
    setError("");
    setSecret("");
    if (step === 0) {
      onExit?.();
      return;
    }
    focusMode.current = "continue";
    setStep(step - 1);
  }

  async function probe(url: string) {
    if (!loopbackUrl(url)) return;
    try {
      const body = await api<{ reachable: boolean }>("/api/profiles/relay-probe", { method: "POST", body: JSON.stringify({ url }) });
      setRelays((current) => current.map((item) => (item.url === url ? { ...item, unreachable: !body.reachable } : item)));
    } catch {
      setRelays((current) => current.map((item) => (item.url === url ? { ...item, unreachable: true } : item)));
    }
  }

  function addRelay() {
    const url = relayDraft.trim();
    if (containsPrivateKey(url)) {
      setRelayDraft("");
      setSecret("relay");
      return;
    }
    let parsed = false;
    try {
      parsed = Boolean(new URL(url));
    } catch {
      parsed = false;
    }
    if (!parsed || (!url.startsWith("ws://") && !url.startsWith("wss://"))) {
      setRelayError("Relay addresses start with ws:// or wss://.");
      return;
    }
    const isPublic = !loopbackUrl(url);
    if (isPublic && !allowPublic) {
      setRelayError("Public relays are off for this profile. Notes sent to a public relay are public and can't be fully taken back.");
      return;
    }
    setRelayError("");
    setRelays((current) => [...current, { url, public: isPublic, unreachable: false }]);
    setRelayDraft("");
    if (!isPublic) void probe(url);
  }

  async function saveProfile() {
    if (saving.current || !kind) return;
    const problem = identityError();
    if (problem) {
      setStep(0);
      setError(problem);
      focusMode.current = "error";
      return;
    }
    saving.current = true;
    setPending(true);
    const current = ticket.current + 1;
    ticket.current = current;
    const body = {
      label: label.trim(),
      npub: npub.trim(),
      signer: { kind },
      relays: relays.map((item) => item.url),
      readNip65,
      allowPublicRelays: allowPublic,
      ...(profile ? { criteriaPath: "" } : {}),
    };
    try {
      const saved = await api<Profile>(profile ? `/api/profiles/${profile.id}` : "/api/profiles", {
        method: profile ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      if (current !== ticket.current) return;
      notifySuccess("Profile saved.");
      onSaved(saved.id);
    } catch (caught) {
      if (current !== ticket.current) return;
      const message = caught instanceof Error ? caught.message : "";
      if (message.includes("already has a profile")) {
        setStep(0);
        setError(message.replace(/^npub:\s*/, ""));
      } else {
        setError("The profile could not be saved. Try again.");
      }
      focusMode.current = "error";
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  const title = steps[step]?.title ?? "Your identity";
  const alert = error;

  return (
    <>
      <form
        className="profile-setup"
        data-testid="profile-create"
        onSubmit={(event) => {
          event.preventDefault();
          if (step < 2) continueFrom(step);
          else void saveProfile();
        }}
      >
        <p className="page-kicker">Set up a profile</p>
        <h1 id="section-title" ref={titleRef} tabIndex={-1}>
          {title}
        </h1>
        <p className="setup-progress">
          {steps.map((item, index) => (
            <span key={item.id}>
              {index > 0 ? <span aria-hidden="true"> · </span> : null}
              <span aria-current={index === step ? "step" : undefined}>{item.name}</span>
            </span>
          ))}
        </p>
        {step === 0 ? (
          <section aria-labelledby="section-title">
            <p className="setup-lead">Use your existing Nostr identity. Your private key stays in your signer.</p>
            <Input id="profile-name" label="Profile name" hint="Only you see this." value={label} error={secret === "label" ? secretWarning : undefined} onChange={(event) => take(event.target.value, setLabel, "label")} />
            {npubOpen ? (
              <Input
                id="profile-npub"
                className="mono"
                label="Public identity (npub)"
                hint="Paste an npub starting with npub1."
                value={npub}
                error={secret === "npub" ? secretWarning : undefined}
                onChange={(event) =>
                  take(event.target.value, (next) => {
                    setNpub(next);
                    if (isNpub(next)) setNpubOpen(false);
                  }, "npub")
                }
              />
            ) : (
              <div className="npub-settled">
                <p className="mono" data-testid="npub-settled">{shortNpub(npub)}</p>
                <Button type="button" variant="ghost" onClick={() => void navigator.clipboard.writeText(npub)}>Copy</Button>
                <Button type="button" variant="ghost" data-testid="change-npub" onClick={() => setNpubOpen(true)}>Change</Button>
              </div>
            )}
          </section>
        ) : null}
        {step === 1 ? (
          <section aria-labelledby="section-title">
            <p className="setup-lead">This chooses how notes will be signed. It does not connect a signer yet.</p>
            <RadioGroup id="signer-kind" label="Signing method" name="signer-kind" options={signerOptions} value={kind} onValueChange={(value) => { setKind(value as SignerKind); setError(""); }} />
            <p className="field-note" data-testid="signer-status" aria-live="polite">{signerStatus(kind)}</p>
          </section>
        ) : null}
        {step === 2 ? (
          <section aria-labelledby="section-title">
            <p className="setup-lead">This stays on this device. It does not publish a public profile.</p>
            <p>You'll write notes yourself. A note is scheduled only when you approve it.</p>
            <p className="field-note">Writing rules for suggestions can be added later, if you use them. This setup does not copy an example brief or approve notes for you.</p>
            <p>Public relays stay off unless you allow them.</p>
            <details className="relay-settings">
              <summary>Relay settings</summary>
              <h2>Relays</h2>
              {relays.length === 0 ? <p className="field-note">No relays yet. Add a local relay, such as ws://127.0.0.1 with its port.</p> : null}
              <ul className="relay-list">
                {relays.map((item) => (
                  <li key={item.url} className={`relay-row${item.public && !allowPublic ? " is-off" : ""}`} data-testid="relay-row">
                    <span className="mono">{item.url}</span>
                    {item.public && allowPublic ? <Badge tone="warning" className="public-badge">Public</Badge> : null}
                    {item.public && !allowPublic ? <span className="muted">Off: public relays not allowed</span> : null}
                    <Button type="button" variant="ghost" aria-label={`Remove ${item.url}`} onClick={() => setRelays((current) => current.filter((row) => row.url !== item.url))}>Remove</Button>
                    {item.unreachable ? (
                      <p className="field-note">Can't reach this relay right now. <button type="button" className="text-button" onClick={() => void probe(item.url)}>Retry</button></p>
                    ) : null}
                  </li>
                ))}
              </ul>
              <div className="relay-add">
                <Input className="mono" label="Relay" value={relayDraft} error={secret === "relay" ? secretWarning : undefined} onChange={(event) => take(event.target.value, setRelayDraft, "relay")} />
                <Button type="button" variant="outline" data-testid="add-relay" onClick={addRelay}>Add relay</Button>
              </div>
              {relayError ? <p className="warn-line" data-testid="relay-warning">{relayError}</p> : null}
              <div className="switch-block">
                <Switch id="nip65-switch" label="Read this npub's relay list (NIP-65)" checked={readNip65} onCheckedChange={setReadNip65} />
                <p className="field-note">Turning this on contacts public relays to fetch your relay list. Public relays found there are listed but stay off unless you allow public relays.</p>
              </div>
              <div className="switch-block public-opt">
                <Switch
                  id="public-switch"
                  label="Allow public relays"
                  checked={allowPublic}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      setAskPublic(true);
                      return;
                    }
                    setAllowPublic(false);
                  }}
                />
                <p className="field-note">Off keeps every note on relays you run.</p>
              </div>
            </details>
          </section>
        ) : null}
        {alert ? (
          <p id="setup-error" className="error" role="alert" tabIndex={-1}>{alert}</p>
        ) : null}
        <div className="profile-actions">
          {step > 0 || onExit ? (
            <Button type="button" variant="outline" data-testid="setup-back" onClick={back}>Back</Button>
          ) : null}
          {step < 2 ? (
            <Button ref={continueRef} type="submit" variant="primary" data-testid="setup-continue">Continue</Button>
          ) : (
            <Button ref={continueRef} type="submit" variant="primary" data-testid="save-profile" disabled={pending}>Save profile</Button>
          )}
        </div>
      </form>
      <ConfirmSheet
        open={askPublic}
        onOpenChange={(open) => {
          setAskPublic(open);
          if (!open) {
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => document.getElementById("public-switch")?.focus());
            });
          }
        }}
        title={`Allow public relays for ${label.trim() || "this profile"}?`}
        description="Notes scheduled for this profile can then go to public relays, where anyone can read them. A deletion request later may not remove them."
        confirmLabel="Allow public relays"
        cancelLabel="Keep them off"
        onConfirm={() => setAllowPublic(true)}
      />
    </>
  );
}
