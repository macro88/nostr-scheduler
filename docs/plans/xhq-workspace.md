# X HQ workspace map for nostr-scheduler

Goal: make the writing workspace as livable as Brandon Builds' X HQ / Jay desk, while keeping the existing loop. Suggest, review, you sign, queue, publish at `created_at`, never early. No bot control of an account. No X impressions or API posting. No DM or lead scraping.

Reference: Brandon Builds, [X HQ / Grok Bot setup](https://www.youtube.com/watch?v=hPey6UVzUjM) (16:13, 24 Nov 2026). PR 16 already landed the wider Compose pane, Upcoming rail, and theme work.

This plan is the delivery checklist. Do not start implementation until the operator says go.

## What changes

UI and research fuel sit on top of the current inbox and queue. The sign and publish path stays as it is. Research never becomes a signed event by itself. A research hit becomes a `ManualDraft` or a `Suggestion` only after an explicit Save or Remix action.

## Settled architecture

Two shapes were compared for research.

1. Extend `WorkItem` with new origins or statuses for outliers and briefs.
2. Keep a separate research store. Promote into the existing draft or suggestion APIs.

Shape 2 wins. Research is fuel, not a post. Putting fuel into the work state machine forces guards on every transition so a hit cannot sign or publish. A separate store parses public relay data at the boundary, then writes through `POST /api/drafts` or `suggest_post` when the operator remixes. The MCP tool list stays free of sign and publish names. Custody checks stay unchanged.

Unsigned board columns are a view over existing statuses, not new states.

| Board label | Existing status |
| --- | --- |
| Rough ideas | `draft` with little or no body, or a short local idea note kept as `draft` |
| Writing | `draft` |
| Ready | `approved` |
| Posted | `sent` in Log or Queue, read-only on the board |

Do not add board-only statuses. Do not let the board enqueue or publish.

Remix reuses `ReplyDraft.parent` (`QuotedParent`) or a note draft that keeps the source text in the UI only. Prefer attaching source metadata on the research record and copying voice text into a normal `Draft`. Do not invent a second draft type until long-form lands.

Outlier scores use public Nostr signals only: replies, reposts, reactions, and zaps relative to that author's recent baseline. No X metrics.

## PR landing order

```
PR-A  drafts desk          ──┐
PR-B  composer preview     ──┼── independent, branch from main
PR-C  calendar drafts      ──┘
         │
         ▼
PR-D  research store scaffold          (after A; B and C may still be open)
         │
         ├── PR-E  outlier scan + curated lists
         ├── PR-F  source + remix → draft/suggestion
         └── PR-G  morning pack + brief as suggestions
         │
         ▼
PR-H  unsigned board view              (after A; prefers D if research cards appear)
         │
         ▼
PR-I  performance view                 (later)
PR-J  best-time hints                  (after I)
PR-K  npub profile lookup              (after I or parallel with J)
PR-L  long-form                        (already later in v1)
```

Independent Now work: **PR-A**, **PR-B**, **PR-C** each branch from `main`.

Next stack: **PR-D** first, then **PR-E**, **PR-F**, **PR-G** can parallelize after D if they touch disjoint modules. Serialize any shared write to `src/domain/types.ts` or `src/work/store.ts`.

Later: **PR-I** before **PR-J**. **PR-K** can follow I. **PR-L** stays last among these.

Review-gated (interaction changes, wait for operator review before merge): **PR-A**, **PR-B**, **PR-C**, **PR-F**, **PR-H**, **PR-K**.

## Hard gates on every PR

- [ ] `pnpm custody:check` passes
- [ ] MCP tool names still match `MCP_TOOL_NAMES` and contain no `sign` or `publish`
- [ ] Publisher still refuses early send (demo `future-on-relay no`)
- [ ] No X API client, no impression counts, no DM scrape modules

---

## PR-A. Drafts desk

Depends on: nothing (main includes PR 16)

Files it may touch:

- `web/src/screens/Composer.tsx`
- `web/src/screens/Inbox.tsx` or a new `web/src/screens/Drafts.tsx`
- `web/src/App.tsx`
- `web/src/api.ts`
- `e2e/*.spec.ts`
- `web/src/theme/layout.css` only if the list needs width rules

One change: list saved `status === "draft"` items for the selected profile, open one into Compose with its text and time, and keep Save without scheduling / Schedule on the existing APIs (`POST /api/drafts`, `POST /api/compose`).

Result you see: Compose (or a Drafts filter) shows saved unsigned notes. Clicking one loads the editor. Scheduling still goes through approve → sign → queue.

Verification:

- [ ] Unit: draft list view model filters only `draft` for the profile
- [ ] Live: save without scheduling twice, open drafts, load the older one, edit, save, confirm one row updates and Schedule still leaves status `approved`
- [ ] Perf: drafts list of 50 synthetic drafts paints under 100 ms on trunk baseline of empty Compose open (measure with Playwright timing or performance marks; fail above 2× trunk)

---

## PR-B. Composer live preview

Depends on: nothing

Files it may touch:

- `web/src/screens/Composer.tsx`
- `web/src/theme/layout.css`
- `e2e/writing-rhythm.spec.ts` or a focused preview spec
- `test/ui-copy.test.ts` if copy changes

One change: show a live preview of the current note, thread segments, or reply beside the editor. Keep the Upcoming rail. Do not add Post or Copy actions that publish. Copy-to-clipboard of text is fine.

Result you see: typing updates the preview in the same viewport. Schedule and Save without scheduling still behave as today.

Verification:

- [ ] Unit: preview text equals editor text for note, thread, and reply fixtures
- [ ] Live: type a note, assert preview matches, schedule it, assert preview clears with the editor
- [ ] Perf: keystroke-to-preview under 50 ms median on a 280-char note (fail above 150 ms); measure against trunk Composer without preview

Review-gated: yes.

---

## PR-C. Calendar for unsigned drafts

Depends on: nothing

Files it may touch:

- `web/src/screens/Calendar.tsx`
- `src/http/app.ts` (`/api/items/:id/reschedule`)
- `src/work/store.ts` only if draft edit-by-time needs a helper
- `src/domain/transitions.ts` only if draft reschedule must stay pure
- `e2e/*calendar*` or `e2e/ui.spec.ts`
- `test/http.test.ts`, `test/behavior.test.ts`

One change: include `draft` in the calendar visible set. Allow moving a draft's `proposedFireAt` (today reschedule accepts only `suggestion` and `approved`). Keep signed and queued times frozen. Drag onto a slot may call the same reschedule endpoint.

Result you see: unsigned saved notes appear on the week view. Dragging or editing time updates the draft only. Signed cards still refuse a new time without discard.

Verification:

- [ ] Unit: reschedule accepts `draft`, rejects `queued` with the frozen-event message
- [ ] Live: save a draft, open Queue week view, move it to another hour, reload, confirm the draft kept the new time and status stayed `draft`
- [ ] Perf: week render with 40 drafts stays within 2× trunk week render time

Review-gated: yes.

---

## PR-D. Research store scaffold

Depends on: PR-A merged preferred so remix can land in the drafts desk; may start after A is reviewable

Files it may touch:

- `src/domain/` new research types and parsers
- `src/research/` store and fetch boundary
- `src/http/app.ts` read-only list routes
- `docs/architecture.md`
- `test/` for parse and store
- `src/mcp/server.ts` only if adding a read-only `list_research` tool (optional; default is HTTP-only in v1 of this PR)

One change: add typed research records (`OutlierHit`, `BriefItem`, `SourcePost`) in SQLite or profile-scoped files under the data dir. Parse relay JSON at the boundary. No UI beyond a stub list or API. No WorkItem status changes. No new sign or publish tools.

Result you see: `GET` research for a profile returns empty or fixture rows. Custody and MCP freezes still pass.

Verification:

- [ ] Unit: invalid relay payloads fail parse; valid fixtures round-trip
- [ ] Live: write one fixture SourcePost via test helper, list it over HTTP, confirm it is absent from `/api/items`
- [ ] Perf: list 200 research rows under 50 ms local SQLite (fail above 200 ms)

---

## PR-E. Outlier scan

Depends on: PR-D

Files it may touch:

- `src/research/`
- `src/cli/main.ts` or a `pnpm research:scan` script
- `src/profiles/` or criteria for curated npub lists
- `CRITERIA-FORMAT.md` / `DEFAULTS.md` if lists live in criteria
- `web/` thin list UI under an Outliers section
- tests and demo fixtures on the local relay

One change: scan curated public npubs on configured read relays, score posts against that author's recent baseline using public replies, reposts, reactions, or zaps, store `OutlierHit` with a multiplier. Suggestions only when the operator remixes later (PR-F).

Result you see: an Outliers list with author, multiplier, and excerpt. Selecting one does not approve or sign anything.

Verification:

- [ ] Unit: given a baseline and a hot post fixture, multiplier matches the pure scoring function
- [ ] Live: local relay with synthetic author posts and reactions; scan writes hits; UI lists them; `/api/items` unchanged
- [ ] Perf: scan of 10 authors × 50 notes finishes under 5 s against local relay (fail above 20 s); explain the number as relay round-trips plus scoring

---

## PR-F. Source plus remix

Depends on: PR-D; uses PR-A drafts desk and PR-B preview when available

Files it may touch:

- `web/src/screens/` remix editor
- `src/http/app.ts` promote endpoint or reuse `/api/drafts` and `/api/suggestions`
- `src/research/` mark consumed
- e2e for remix save

One change: open a research hit beside an editable remix. Actions are Save to drafts, Copy text, and optional Edit in Compose. Post means Schedule only after the normal approve path, never a direct publish. Keep source text read-only.

Result you see: Save to drafts creates a `ManualDraft`. Inbox suggestions appear only if the operator or suggester writes a `Suggestion`. Sign and publish tools are unchanged.

Verification:

- [ ] Unit: promote maps SourcePost → Draft without private-key content; research row remains or marks remixed without becoming queued
- [ ] Live: remix an outlier, Save to drafts, open drafts desk, schedule, sign with mock signer, confirm publish still waits for fire time
- [ ] Perf: open remix view under 100 ms for a cached SourcePost (fail above 300 ms)

Review-gated: yes.

---

## PR-G. Morning pack and daily brief

Depends on: PR-D for brief items as research; morning pack can use existing `suggest_post` alone

Files it may touch:

- suggester docs / examples
- `src/research/` for brief storage
- `web/src/screens/Inbox.tsx` grouping for pack and brief
- optional read-only MCP `list_research`
- tests

One change: present about five niche brief items and a morning draft pack as inbox fuel. Pack members are ordinary `Suggestion` rows from `suggest_post`. Brief items stay research until remixed. No auto-sign. No auto-approve.

Result you see: Inbox shows a morning group. Approving still requires the human. Rejecting writes feedback as today.

Verification:

- [ ] Unit: pack grouping by rationale tag or created day does not drop ordinary suggestions
- [ ] Live: insert five suggestions and five brief research rows; approve one suggestion; confirm research briefs stay unsigned and unqueued
- [ ] Perf: inbox with 30 suggestions + 10 briefs opens under 2× trunk inbox open time

---

## PR-H. Unsigned board

Depends on: PR-A; optional research cards after D

Files it may touch:

- new `web/src/screens/Board.tsx`
- `web/src/App.tsx`
- CSS layout
- e2e

One change: kanban columns over unsigned work using the mapping table above. Drag between Rough, Writing, and Ready only updates draft content or runs approve for Ready. Never signs. Never publishes. Posted column is a read-only mirror of recent `sent` items or is omitted until Log links exist.

Result you see: dragging Writing → Ready calls approve. Dragging to Posted is impossible.

Verification:

- [ ] Unit: column assignment function covers each status once
- [ ] Live: draft on Writing, drag to Ready, assert status `approved`, Sign page lists it, no relay send
- [ ] Perf: board with 40 unsigned items within 2× drafts desk open time

Review-gated: yes.

---

## PR-I. Performance view

Depends on: Next stack useful; can start after E has scoring primitives

Files it may touch:

- `src/research/` or `src/analytics/`
- web Analytics screen
- tests with local relay fixtures

One change: quiet daily view of the operator's own public notes with reply, repost, reaction, and zap multiples. Top and bottom bands (for example 20%). Do more / do less labels from those bands. No X impressions.

Verification:

- [ ] Unit: band cutoffs on a fixed fixture list
- [ ] Live: synthetic sent notes on local relay with reactions; view shows multiplier and bands
- [ ] Perf: profile scan of 100 notes under 5 s local (fail above 20 s)

---

## PR-J. Best-time hints

Depends on: PR-I

Files it may touch:

- analytics helpers
- `WhenField` / Compose / Calendar hint UI
- criteria `preferredHours` remain authoritative until the human edits them

One change: optional hour hints from public engagement timing. Hints never move a signed event. Hints never auto-schedule.

Verification:

- [ ] Unit: hint hours from fixture timestamps
- [ ] Live: Compose shows hint text; scheduling still uses the chosen time
- [ ] Perf: hint compute under 20 ms for cached analytics (fail above 100 ms)

---

## PR-K. Profile lookup

Depends on: PR-I preferred for shared fetch helpers

Files it may touch:

- research fetch
- web Profile lookup screen
- docs

One change: paste an npub, show cadence, post-type mix, and topic pillars from public events. Patterns only. No generated wording that auto-queues.

Verification:

- [ ] Unit: pillar extraction on fixtures
- [ ] Live: lookup a fixture npub on local relay; no WorkItem created
- [ ] Perf: lookup under 5 s local for 100 notes (fail above 20 s)

Review-gated: yes.

---

## PR-L. Long-form

Depends on: product call already marked later in v1

Files: domain draft kinds, signer kind support, Compose, publisher, MCP draft parse, custody

One change: add long-form as a first-class draft kind when v1 is ready. Out of scope for the Now and Next waves.

Verification: define when that wave starts. Until then leave unchecked.

---

## Out of scope

- Bot or MCP control of an account
- X impressions, X API posting, Grok Bot publish
- Auto-sign or auto-publish
- DM or lead scraping / unfinished Outreach clone
- New MCP tools whose names contain `sign` or `publish`

## Unproven until a PR runs

- Creative-director density and layout against the X HQ stills (visual direction for Now UI)
- Exact outlier formula weights on real public Nostr data (fixtures first, then one live scan the operator opts into)
- Whether morning brief text is authored by the external suggester or a local template
- Physical-phone, software-keyboard, and screen-reader coverage (same gap PR 16 left open)

## Operator go sequence

1. Merge review-gated Now PRs A, B, C in any order after each passes its boxes.
2. Land D, then E, F, G.
3. Land H when unsigned desk volume needs a board.
4. Start Later only after Next is in daily use.
