import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Badge, Button, ConfirmSheet, Input } from "@macro88/ui";
import { api, type Profile } from "../api";
import { containsPrivateKey } from "../../../src/domain/private-key.js";
import { isNpub, shortNpub } from "../npub";
import { fieldCollapse, fieldCollapseReduced, fieldExpand, fieldExpandReduced } from "../profile-motion";
import { notifySuccess } from "../toasts";

export const SheetHostContext = createContext<HTMLElement | null>(null);

const secretWarning =
  "That's a private key (nsec). This app never needs it. Paste your npub, and keep your nsec in your signer.";

type SecretField = "label" | "npub" | "criteria" | "bunker" | "relay" | null;
type SignerKind = "" | "nip07" | "nip46" | "nip55";
type RelayRow = { url: string; public: boolean; unreachable: boolean };

function loopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "ws:" || url.protocol === "wss:") &&
      ["127.0.0.1", "localhost", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""))
    );
  } catch {
    return false;
  }
}

function plain(error: unknown): string {
  const message = error instanceof Error ? error.message : "The profile could not be saved.";
  const split = message.indexOf(": ");
  return split === -1 ? message : message.slice(split + 2);
}

function useReduced(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function ProfileForm({
  mode,
  profile,
  onSaved,
  onRemoved,
}: {
  mode: "create" | "edit";
  profile?: Profile;
  onSaved: (id: string) => void;
  onRemoved?: () => void;
}) {
  const sheetHost = useContext(SheetHostContext);
  const reduced = useReduced();
  const collapse = reduced ? fieldCollapseReduced : fieldCollapse;
  const expand = reduced ? fieldExpandReduced : fieldExpand;
  const [label, setLabel] = useState(profile?.label ?? "");
  const [npub, setNpub] = useState(profile?.npub ?? "");
  const [npubOpen, setNpubOpen] = useState(!profile?.npub);
  const [criteria, setCriteria] = useState(profile?.criteriaPath ?? "");
  const [criteriaMissing, setCriteriaMissing] = useState(profile ? profile.criteriaExists === false : false);
  const [kind, setKind] = useState<SignerKind>(profile?.signer.kind === "nip07" || profile?.signer.kind === "nip46" || profile?.signer.kind === "nip55" ? profile.signer.kind : "");
  const [bunker, setBunker] = useState("");
  const [settled, setSettled] = useState(Boolean(profile?.signer.kind === "nip46" && profile.signer.bunkerUri && profile.signer.bunkerUri.length > "bunker://".length));
  const [relays, setRelays] = useState<RelayRow[]>(
    (profile?.relays ?? []).map((item) => ({ url: item.url, public: item.public, unreachable: false })),
  );
  const [relayDraft, setRelayDraft] = useState("");
  const [relayError, setRelayError] = useState("");
  const [readNip65, setReadNip65] = useState(profile?.readNip65 === true);
  const [allowPublic, setAllowPublic] = useState(profile?.allowPublicRelays === true);
  const [askPublic, setAskPublic] = useState(false);
  const [askRemove, setAskRemove] = useState(false);
  const [secretField, setSecretField] = useState<SecretField>(null);
  const [npubError, setNpubError] = useState("");
  const [formError, setFormError] = useState("");
  const [pending, setPending] = useState(false);
  const bunkerWrap = useRef<HTMLDivElement>(null);
  const npubWrap = useRef<HTMLDivElement>(null);
  const radioRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const changeRef = useRef<HTMLButtonElement>(null);
  const pairAgainRef = useRef<HTMLButtonElement>(null);
  const prevKind = useRef(kind);
  const prevOpen = useRef(npubOpen);
  const prevSettled = useRef(settled);
  const validNpub = isNpub(npub);

  useEffect(() => {
    if (kind === "nip46" && prevKind.current !== "nip46" && !settled) bunkerWrap.current?.querySelector("input")?.focus();
    if (prevKind.current === "nip46" && kind !== "nip46" && kind) radioRefs.current[kind]?.focus();
    prevKind.current = kind;
  }, [kind, settled]);

  useEffect(() => {
    if (!npubOpen && prevOpen.current) changeRef.current?.focus();
    if (npubOpen && !prevOpen.current) {
      const node = npubWrap.current?.querySelector("input");
      node?.focus();
      if (node) node.setSelectionRange(node.value.length, node.value.length);
    }
    prevOpen.current = npubOpen;
  }, [npubOpen]);

  useEffect(() => {
    if (settled && !prevSettled.current) pairAgainRef.current?.focus();
    if (!settled && prevSettled.current) bunkerWrap.current?.querySelector("input")?.focus();
    prevSettled.current = settled;
  }, [settled]);

  function refuse(field: SecretField, clear: () => void) {
    clear();
    setSecretField(field);
  }

  function take(field: SecretField, value: string, apply: (next: string) => void) {
    if (containsPrivateKey(value)) {
      refuse(field, () => apply(""));
      return;
    }
    if (secretField === field) setSecretField(null);
    apply(value);
  }

  async function lookAtCriteria(path: string) {
    if (!path.trim()) {
      setCriteriaMissing(false);
      return;
    }
    try {
      const body = await api<{ exists: boolean }>(`/api/criteria-path?path=${encodeURIComponent(path.trim())}`);
      setCriteriaMissing(!body.exists);
      setFormError("");
    } catch (error) {
      setFormError(plain(error));
    }
  }

  async function probe(url: string) {
    if (!loopbackUrl(url)) return;
    try {
      const body = await api<{ reachable: boolean; probed: boolean }>("/api/profiles/relay-probe", {
        method: "POST",
        body: JSON.stringify({ url }),
      });
      setRelays((current) => current.map((item) => (item.url === url ? { ...item, unreachable: body.probed && !body.reachable } : item)));
    } catch {
      setRelays((current) => current.map((item) => (item.url === url ? { ...item, unreachable: true } : item)));
    }
  }

  function addRelay() {
    const url = relayDraft.trim();
    if (containsPrivateKey(url)) {
      refuse("relay", () => setRelayDraft(""));
      return;
    }
    if (!loopbackUrl(url) && !/^wss?:\/\//.test(url)) {
      setRelayError("Relay addresses start with ws:// or wss://.");
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

  async function save() {
    setNpubError("");
    setFormError("");
    if (!label.trim() || !kind || !validNpub) {
      if (!validNpub) setNpubError(/^[0-9a-fA-F]{64}$/.test(npub.trim()) ? "That looks like a hex key. Paste the npub instead." : "That isn't an npub. It starts with npub1.");
      if (!label.trim() || !kind) setFormError("Add a label and choose a signer.");
      return;
    }
    setPending(true);
    const body = {
      label: label.trim(),
      npub: npub.trim(),
      signer: kind === "nip46" ? (settled ? { kind } : { kind, bunkerUri: bunker }) : { kind },
      criteriaPath: criteria.trim(),
      relays: relays.map((item) => item.url),
      readNip65,
      allowPublicRelays: allowPublic,
    };
    try {
      const saved = await api<Profile>(mode === "create" ? "/api/profiles" : `/api/profiles/${profile?.id}`, {
        method: mode === "create" ? "POST" : "PATCH",
        body: JSON.stringify(body),
      });
      if (kind === "nip46" && bunker && !settled) setBunker("");
      notifySuccess("Profile saved.");
      onSaved(saved.id);
    } catch (error) {
      const message = plain(error);
      if (message.includes("npub") || message.includes("hex") || message.includes("profile:")) setNpubError(message);
      else setFormError(message);
    } finally {
      setPending(false);
    }
  }

  async function pair() {
    if (!profile || !bunker.trim()) return;
    if (containsPrivateKey(bunker)) {
      refuse("bunker", () => setBunker(""));
      return;
    }
    setPending(true);
    try {
      await api("/api/nip46/pair", { method: "POST", body: JSON.stringify({ profileId: profile.id, bunkerUri: bunker }) });
      setBunker("");
      setSettled(true);
    } catch (error) {
      setFormError(plain(error));
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!profile) return;
    setPending(true);
    try {
      await api(`/api/profiles/${profile.id}`, { method: "DELETE" });
      notifySuccess("Profile removed.");
      onRemoved?.();
    } catch (error) {
      setFormError(plain(error));
    } finally {
      setPending(false);
      setAskRemove(false);
    }
  }

  const masked = profile?.signer.bunkerUri ?? "bunker://";
  const count = profile?.queuedOrSigned ?? 0;
  const removeCopy =
    count === 0
      ? "This profile has no queued or signed notes."
      : `This discards ${count} queued or signed ${count === 1 ? "note" : "notes"} for this profile. They haven't been published and can't be recovered.`;

  const sheets = (
    <>
      <ConfirmSheet
        open={askPublic}
        onOpenChange={setAskPublic}
        title={`Allow public relays for ${label.trim() || "this profile"}?`}
        description="Notes scheduled for this profile can then go to public relays, where anyone can read them. A deletion request later may not remove them."
        confirmLabel="Allow public relays"
        cancelLabel="Keep them off"
        onConfirm={() => setAllowPublic(true)}
      />
      <ConfirmSheet
        open={askRemove}
        onOpenChange={setAskRemove}
        title={`Remove ${label.trim() || "this profile"}?`}
        description={removeCopy}
        confirmLabel="Remove profile"
        cancelLabel="Keep it"
        destructive
        onConfirm={() => void remove()}
      />
    </>
  );

  return (
    <form
      className="profile-setup"
      data-testid={mode === "create" ? "profile-create" : "profile-detail"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {mode === "create" ? (
        <h1 id="section-title" tabIndex={-1}>
          Set up a profile
        </h1>
      ) : null}
      <section aria-labelledby="profile-section">
        <h2 id="profile-section">Profile</h2>
        <Input
          label="Label"
          hint="Only you see this."
          value={label}
          aria-invalid={secretField === "label" || undefined}
          onChange={(event) => take("label", event.target.value, setLabel)}
        />
        {secretField === "label" ? <SecretLine /> : null}
        <AnimatePresence mode="sync" initial={false}>
          {npubOpen ? (
            <motion.div
              key="npub-open"
              ref={npubWrap}
              initial={{ opacity: 0, height: expand.container.height }}
              animate={{ opacity: expand.incoming.opacity, height: "auto", transition: expand.incoming.transition }}
              exit={{
                opacity: collapse.outgoing.opacity,
                height: collapse.container.height,
                transition: { opacity: collapse.outgoing.transition, height: collapse.container.transition },
              }}
            >
              <Input
                className="mono"
                label="npub"
                value={npub}
                aria-invalid={secretField === "npub" || Boolean(npubError) || undefined}
                onChange={(event) => {
                  take("npub", event.target.value, (next) => {
                    setNpub(next);
                    setNpubError("");
                    if (isNpub(next)) setNpubOpen(false);
                  });
                }}
              />
            </motion.div>
          ) : (
            <motion.div
              key="npub-settled"
              className="npub-settled"
              initial={{ opacity: 0 }}
              animate={{ opacity: collapse.incoming.opacity, height: "auto", transition: collapse.incoming.transition }}
              exit={{ opacity: expand.outgoing.opacity, transition: expand.outgoing.transition }}
            >
              <p className="mono" data-testid="npub-settled" aria-live="polite">
                {shortNpub(npub)}
              </p>
              <Button type="button" variant="ghost" onClick={() => void navigator.clipboard.writeText(npub)}>
                Copy
              </Button>
              <Button ref={changeRef} type="button" variant="ghost" data-testid="change-npub" onClick={() => setNpubOpen(true)}>
                Change
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
        {secretField === "npub" ? <SecretLine /> : null}
        {npubError ? <p className="field-note">{npubError}</p> : null}
        <Input
          className="mono"
          label="Criteria file"
          hint="A path inside the data directory."
          value={criteria}
          aria-invalid={secretField === "criteria" || undefined}
          onChange={(event) => take("criteria", event.target.value, setCriteria)}
          onBlur={() => void lookAtCriteria(criteria)}
        />
        {secretField === "criteria" ? <SecretLine /> : null}
        {criteriaMissing ? <p className="field-note">No file at that path in the data directory.</p> : null}
      </section>
      <section aria-labelledby="signer-section">
        <h2 id="signer-section">Signer</h2>
        {/* waiting for the library RadioGroup */}
        <fieldset className="signer-choice">
          <legend>Signer kind</legend>
          {(
            [
              ["nip07", "Browser signer (NIP-07)"],
              ["nip46", "Bunker (NIP-46)"],
              ["nip55", "Android signer (NIP-55)"],
            ] as const
          ).map(([value, text]) => (
            <label key={value}>
              <input
                ref={(node) => {
                  radioRefs.current[value] = node;
                }}
                type="radio"
                name="signer-kind"
                value={value}
                checked={kind === value}
                data-testid={`signer-${value}`}
                onChange={() => setKind(value)}
              />
              {text}
            </label>
          ))}
        </fieldset>
        {kind === "nip46" ? (
          <div data-testid="bunker-field">
            {settled ? (
              <p className="mono" data-testid="bunker-masked">
                {masked}
              </p>
            ) : (
            <div ref={bunkerWrap}>
              <Input
                className="mono"
                label="Bunker link"
                placeholder="bunker://"
                value={bunker}
                aria-invalid={secretField === "bunker" || undefined}
                onChange={(event) => take("bunker", event.target.value, setBunker)}
              />
            </div>
            )}
            {secretField === "bunker" ? <SecretLine /> : null}
            <p className="bunker-status" data-testid="pair-state" aria-live="polite">
              {settled ? "Paired" : "Not paired"}
            </p>
            {settled ? (
              <Button
                ref={pairAgainRef}
                type="button"
                variant="ghost"
                data-testid="pair-again"
                onClick={() => {
                  setBunker("");
                  setSettled(false);
                  if (!profile) return;
                  void api(`/api/profiles/${profile.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({
                      label: label.trim(),
                      npub: npub.trim(),
                      signer: { kind: "nip46", bunkerUri: "" },
                      criteriaPath: criteria.trim(),
                      relays: relays.map((item) => item.url),
                      readNip65,
                      allowPublicRelays: allowPublic,
                    }),
                  });
                }}
              >
                Pair again
              </Button>
            ) : profile ? (
              <Button type="button" variant="outline" data-testid="pair-bunker" onClick={() => void pair()} disabled={!bunker.trim() || pending}>
                Pair
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>
      <section aria-labelledby="relay-section">
        <h2 id="relay-section">Relays</h2>
        {relays.length === 0 ? <p className="field-note">No relays yet. Add a local relay, such as ws://127.0.0.1 with its port.</p> : null}
        <ul className="relay-list">
          {relays.map((item) => (
            <li key={item.url} className={`relay-row${item.public && !allowPublic ? " is-off" : ""}`} data-testid="relay-row">
              <span className="mono">{item.url}</span>
              {item.public && allowPublic ? (
                <Badge tone="warning" className="public-badge">
                  Public
                </Badge>
              ) : null}
              {item.public && !allowPublic ? <span className="muted">Off: public relays not allowed</span> : null}
              <Button type="button" variant="ghost" onClick={() => setRelays((current) => current.filter((row) => row.url !== item.url))}>
                Remove
              </Button>
              {item.unreachable ? (
                <p className="field-note">
                  Can't reach this relay right now.{" "}
                  <button type="button" className="text-button" onClick={() => void probe(item.url)}>
                    Retry
                  </button>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="relay-add">
          <Input
            className="mono"
            label="Relay"
            value={relayDraft}
            aria-invalid={secretField === "relay" || Boolean(relayError) || undefined}
            onChange={(event) => take("relay", event.target.value, setRelayDraft)}
          />
          <Button type="button" variant="outline" data-testid="add-relay" onClick={addRelay}>
            Add relay
          </Button>
        </div>
        {secretField === "relay" ? <SecretLine /> : null}
        {relayError ? (
          <p className="warn-line" data-testid="relay-warning">
            {relayError}
          </p>
        ) : null}
        <div className="switch-block">
          {/* waiting for the library Switch */}
          <label className="switch">
            <input type="checkbox" role="switch" checked={readNip65} data-testid="nip65-switch" onChange={(event) => setReadNip65(event.target.checked)} />
            Read this npub's relay list (NIP-65)
          </label>
          <p className="field-note">Turning this on contacts public relays to fetch your relay list. Public relays found there are listed but stay off unless you allow public relays.</p>
        </div>
        <div className="switch-block public-opt">
          {/* waiting for the library Switch */}
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={allowPublic}
              data-testid="public-switch"
              onChange={(event) => {
                if (event.target.checked) {
                  setAskPublic(true);
                  return;
                }
                setAllowPublic(false);
              }}
            />
            Allow public relays
          </label>
          <p className="field-note">Off keeps every note on relays you run.</p>
        </div>
      </section>
      {formError ? <p className="field-note">{formError}</p> : null}
      <div className="profile-actions">
        <Button type="submit" variant="primary" data-testid="save-profile" disabled={pending || Boolean(secretField)}>
          {mode === "create" ? "Save profile" : "Save changes"}
        </Button>
        {mode === "edit" ? (
          <Button type="button" variant="ghost" className="danger-text" style={{ color: "var(--color-danger-fg)" }} data-testid="remove-profile" onClick={() => setAskRemove(true)}>
            Remove profile
          </Button>
        ) : null}
      </div>
      {sheetHost ? createPortal(sheets, sheetHost) : sheets}
    </form>
  );
}

function SecretLine() {
  return (
    <p className="secret-line" role="alert" aria-live="assertive" data-testid="secret-alert">
      {secretWarning}
    </p>
  );
}
