import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Button, EmptyState, Input } from "@macro88/ui";
import { containsPrivateKey } from "../../../src/domain/private-key.js";
import { api } from "../api";
import { isNpub, shortNpub } from "../npub";
import { usePendingSurface } from "../pending";
import { InlineError, LoadingBlock } from "../states";

const secretWarning =
  "That's a private key (nsec). This app never needs it. Paste your npub, and keep your nsec in your signer.";

type Mix = {
  note: number;
  reply: number;
  quote: number;
  repost: number;
};

type Pillar = {
  label: string;
  notes: number;
};

type Cadence = {
  posts: number;
  windowSeconds: number;
  postsPerWeek: number | null;
  medianGapSeconds: number | null;
};

type LookupReport = {
  npub: string;
  metadata: { name: string | null; about: string | null };
  cadence: Cadence;
  mix: Mix;
  pillars: Pillar[];
};

function canonicalNpub(value: string): string {
  const trimmed = value.trim();
  return trimmed === trimmed.toUpperCase() ? trimmed.toLowerCase() : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRate(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function parseReport(value: unknown): LookupReport {
  if (!isRecord(value) || !isRecord(value.metadata) || !isRecord(value.cadence) || !isRecord(value.mix) || !Array.isArray(value.pillars)) {
    throw new Error("The profile lookup was unreadable.");
  }
  const name = value.metadata.name;
  const about = value.metadata.about;
  const posts = value.cadence.posts;
  const windowSeconds = value.cadence.windowSeconds;
  const postsPerWeek = value.cadence.postsPerWeek;
  const medianGapSeconds = value.cadence.medianGapSeconds;
  const note = value.mix.note;
  const reply = value.mix.reply;
  const quote = value.mix.quote;
  const repost = value.mix.repost;
  if (
    typeof value.npub !== "string" ||
    (name !== null && typeof name !== "string") ||
    (about !== null && typeof about !== "string") ||
    !isCount(posts) ||
    !isCount(windowSeconds) ||
    !isRate(postsPerWeek) ||
    !isRate(medianGapSeconds) ||
    !isCount(note) ||
    !isCount(reply) ||
    !isCount(quote) ||
    !isCount(repost)
  ) {
    throw new Error("The profile lookup was unreadable.");
  }
  const pillars: Pillar[] = [];
  for (const pillar of value.pillars) {
    if (!isRecord(pillar) || typeof pillar.label !== "string" || pillar.label.trim().length === 0 || !isCount(pillar.notes)) {
      throw new Error("The profile lookup was unreadable.");
    }
    pillars.push({ label: pillar.label, notes: pillar.notes });
  }
  return {
    npub: value.npub,
    metadata: { name, about },
    cadence: { posts, windowSeconds, postsPerWeek, medianGapSeconds },
    mix: { note, reply, quote, repost },
    pillars,
  };
}

function countWord(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatRate(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatGap(seconds: number): string {
  if (seconds < 90 * 60) return countWord(Math.max(1, Math.round(seconds / 60)), "minute", "minutes");
  if (seconds < 36 * 3600) return countWord(Math.max(1, Math.round(seconds / 3600)), "hour", "hours");
  return countWord(Math.max(1, Math.round(seconds / 86400)), "day", "days");
}

function cadenceText(cadence: Cadence): string {
  if (cadence.posts === 0) return "No public posts in the latest 100.";
  const posts = countWord(cadence.posts, "public post", "public posts");
  if (cadence.postsPerWeek === null || cadence.medianGapSeconds === null) {
    if (cadence.posts === 1) return "1 public post. One post is not a weekly rate.";
    return `${posts} share one timestamp, so there is no weekly rate.`;
  }
  const rate = formatRate(cadence.postsPerWeek);
  return `${posts}. About ${countWord(Number(rate), "post", "posts")} a week. Typical gap ${formatGap(cadence.medianGapSeconds)}.`;
}

function mixLine(mix: Mix): string {
  return [
    countWord(mix.note, "note", "notes"),
    countWord(mix.reply, "reply", "replies"),
    countWord(mix.quote, "quote", "quotes"),
    countWord(mix.repost, "repost", "reposts"),
  ].join(", ");
}

export function Lookup({ profileId }: { profileId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [submitted, setSubmitted] = useState("");
  const lookup = useQuery({
    queryKey: ["profile-lookup", profileId, submitted],
    enabled: submitted.length > 0,
    queryFn: async () =>
      parseReport(
        await api<unknown>(`/api/profile-lookup?profileId=${encodeURIComponent(profileId)}&npub=${encodeURIComponent(submitted)}`),
      ),
  });
  const report = lookup.data;
  const surface = usePendingSurface(lookup.isFetching && !report);

  function fail(message: string) {
    setFieldError(message);
    setSubmitted("");
    document.getElementById("lookup-npub")?.focus();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = canonicalNpub(draft);
    if (containsPrivateKey(draft) || containsPrivateKey(normalized)) {
      fail(secretWarning);
      return;
    }
    if (!isNpub(normalized)) {
      fail(/^[0-9a-fA-F]{64}$/.test(normalized) ? "That looks like a hex key. Paste the npub instead." : "That isn't an npub. It starts with npub1.");
      return;
    }
    setFieldError("");
    if (normalized === submitted) {
      void queryClient.invalidateQueries({ queryKey: ["profile-lookup", profileId, normalized] });
      return;
    }
    setSubmitted(normalized);
  }

  const shown = Boolean(report && !lookup.isError);

  return (
    <section data-testid="lookup" aria-label="Lookup">
      <div className="page-head compact">
        <div className="title-row">
          <h1 id="section-title" tabIndex={-1}>
            Lookup
          </h1>
          <p className="page-kicker">Public posting patterns. Nothing is saved or queued.</p>
        </div>
      </div>
      <search>
        <form className="lookup-form" method="get" aria-labelledby="section-title" onSubmit={onSubmit}>
          <Input
            id="lookup-npub"
            name="npub"
            label="Public npub"
            hint="Starts with npub1."
            error={fieldError || undefined}
            required
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            value={draft}
            data-testid="lookup-npub"
            onChange={(event) => {
              setDraft(event.target.value);
              if (fieldError) setFieldError("");
            }}
          />
          <Button type="submit" variant="primary" data-testid="lookup-submit" disabled={lookup.isFetching} pending={lookup.isFetching}>
            Look up
          </Button>
        </form>
      </search>
      {lookup.isFetching && !report && !surface.loading ? <p className="sr">Loading lookup</p> : null}
      <LoadingBlock pending={surface.loading} label="Loading lookup" />
      {lookup.isError ? <InlineError error={lookup.error} fallback="That npub could not be read. Try again." /> : null}
      {!submitted && !lookup.isError ? (
        <div data-testid="empty">
          <EmptyState title="Paste a public npub." />
        </div>
      ) : null}
      {shown && report ? (
        <div className="lookup-patterns" data-testid="lookup-result" role="status">
          <p data-testid="lookup-name">{report.metadata.name ? `${report.metadata.name}, ${shortNpub(report.npub)}` : shortNpub(report.npub)}</p>
          {report.metadata.about ? (
            <p className="lookup-about" data-testid="lookup-about">
              {report.metadata.about}
            </p>
          ) : null}
          <section>
            <h2>Cadence</h2>
            <p data-testid="lookup-cadence">{cadenceText(report.cadence)}</p>
          </section>
          <section>
            <h2>Post types</h2>
            <p data-testid="lookup-mix">{mixLine(report.mix)}</p>
          </section>
          <section>
            <h2>Topic pillars</h2>
            {report.pillars.length === 0 ? (
              <p data-testid="lookup-pillars">No repeated topic in these posts.</p>
            ) : (
              <ul className="performance-list" data-testid="lookup-pillars">
                {report.pillars.map((pillar) => (
                  <li key={pillar.label} className="performance-note">
                    <p className="count">{pillar.notes}</p>
                    <p>{pillar.label}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}
