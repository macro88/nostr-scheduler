# nostr-scheduler

A local composer and scheduler for Nostr. Suggesters propose posts against a criteria file you edit. You review those suggestions and sign them with your own signer. The app stores the signed events and broadcasts each one at its `created_at`, never earlier.

It runs on your machine. If the machine is asleep or offline at fire time, the post does not go out on time. See [Safety defaults](#safety-defaults).

## Zero custody

This app never sees, asks for, or stores an `nsec`. There is no environment variable for an account secret, and no fallback that loads one.

You sign with a signer you already use.

- NIP-07 in the browser, through a page the app serves on `127.0.0.1`
- NIP-46 bunker, for example Amber or Hypergolic
- NIP-55 on Android. A desktop process cannot send Android intents. On a desktop the app tells you to use the bunker path instead

A mock signer exists for tests and the local demo only. It generates a throwaway key in memory and will not attach to a profile outside test or demo mode. The demo does not keep that key on disk.

A bunker connection keeps a session key so it can talk to the bunker. That key is not an `nsec`. It cannot sign a post by itself. It can only ask the bunker to sign, and the connect request asks for `sign_event` on kind 1 alone. It does not ask for encrypt or decrypt permission.

By default the session key is stored in the OS keychain: macOS Keychain, Secret Service on Linux, or Windows Credential Manager. If no keychain is available, pairing stops. Pass `--allow-file-session`, or set `NOSTR_SCHEDULER_ALLOW_FILE_SESSION=1`, to store it in `data/nip46/client.json` with mode `0600` instead. The app prints a warning when it does that. Anyone who can read that file can ask the bunker for signatures within the permissions the bunker granted.

An existing `client.json` is copied into the keychain and then deleted.

Leave per-request approval on in Amber or Hypergolic. The session key is then not enough on its own. The bunker still asks you before each signature.

`node src/cli/main.ts disconnect` removes the session key from the keychain and deletes `client.json`.

`pnpm custody:check` fails if account-secret handling appears outside the mock signer. The bunker session module is the only other file allowed to hold a connection key, and it still cannot mention an `nsec`.

## Setup

You need Node 22 or newer and pnpm 10.

```bash
git clone https://github.com/macro88/nostr-scheduler.git
cd nostr-scheduler
pnpm install
```

Add a profile in `data/profiles.yaml` with its `npub`, signer kind, relay list, suggester id, and the path to its criteria file. Copy `examples/criteria/example-profile.md` and edit it. The format is described in `CRITERIA-FORMAT.md`.

```yaml
profiles:
  - id: example
    label: Example
    npub: npub1...
    pubkey: "<64 lowercase hex characters>"
    suggester_id: example-suggester
    signer:
      kind: nip07
    relays:
      - ws://127.0.0.1:7777
    read_nip65: false
    allow_public_relays: false
    criteria_path: criteria/example.md
```

Do not put an `nsec` in any config file. `read_nip65` defaults to false when omitted. A relay that is not on the loopback interface is not used for publishing until that profile sets `allow_public_relays: true`. See [Profiles](#profiles).

## Profiles

Profiles live in `data/profiles.yaml`. The app reads and writes that file, so a profile you add in the page is the same profile the CLI sees. The HTTP API binds to `127.0.0.1` only.

`GET /api/profiles` lists profiles. `POST /api/profiles` creates one. `PATCH /api/profiles/:id` updates one. `DELETE /api/profiles/:id` removes one. A delete discards queued and signed notes for that profile on this machine. It does not send them.

Send an `npub`. The server derives the hex pubkey and stores it. A hex pubkey in the `npub` field is rejected. Any field that contains `nsec1` is rejected before it is validated or stored, and the value is not written to the file or to the error.

`read_nip65` defaults to false. The NIP-65 switch says that turning it on contacts public relays.

`allow_public_relays` defaults to false. Loopback publish relays (`ws://127.0.0.1`, `ws://localhost`, `ws://[::1]`, any port, and the `wss` forms of those hosts) are used. Any other publish relay is kept in the file and flagged, and the publisher does not use it, until `allow_public_relays` is true. A hand-edited public relay with the flag omitted or false is treated the same way.

A relay named inside a `bunker://` link is only the NIP-46 channel. It is not a publish relay, and it is not subject to the public-relay flag. Responses show that link as `bunker://` plus a shortened pubkey. The secret stays in the file and is not returned.

The criteria path has to resolve inside the data directory. The file does not have to exist yet. The profile says whether it does.

If a profile already lists a public relay and does not set `allow_public_relays: true`, that relay is no longer used for publishing. Set the flag to keep using it.

Check a criteria file with:

```bash
pnpm criteria:validate
```

Review commands, from `data/` as the default directory:

```bash
node src/cli/main.ts status
node src/cli/main.ts approve <id>
node src/cli/main.ts reject <id> --reason "..."
node src/cli/main.ts edit <id> --content "..."
node src/cli/main.ts sign
node src/cli/main.ts publish
node src/cli/main.ts mcp
node src/cli/main.ts disconnect
```

`sign` signs every approved item, root first for a thread, then queues the signed events. `publish` sends due events and will not send early. `publish --watch` repeats that check once a second. `mcp` speaks newline-delimited JSON-RPC on standard input.

## Local UI

`pnpm ui` builds the React app and serves it with the API on `127.0.0.1:4173`. The page talks only to that process. The CLI and the MCP server are unchanged.

The interface uses the shared Nostr theme from `@macro88/theme-nostr`. UI text is Be Vietnam Pro. Notes are Literata. Copyable values, such as a bunker link, use IBM Plex Mono. Light is the default. Dark follows the system, and the header switches `data-scheme` on the document.

## Design system

The screen uses `@macro88/ui` and `@macro88/theme-nostr` at v0.1.0. Those packages are not on npm. `package.json` points at the GitHub release tarballs, and `pnpm-workspace.yaml` overrides every `@macro88` package to the same release so pnpm does not look on npm.

To bump the design system, replace each tarball URL in both files with the new release, then run `pnpm install` and commit the lockfile. The stylesheet order and the `data-theme="nostr"` attribute are described in that release's INSTALL.md.

The inbox lists suggestions for the selected profile. Approve, edit, or reject them there. A rejection is written to that profile's feedback file after a short undo. Compose schedules a note, a thread, or a reply, then clears the editor. The queue shows the week or the day, with the current time marked. An unsigned time can move. A signed time is frozen, and removing a signed or queued item asks you to confirm over the rest of the page.

Times use British English and a 24-hour clock, for example Wed 11 Nov, 14:30. The schedule control is that same form, not the browser's time field. Keys 1 to 5 switch sections. In the inbox, J and K to move, A to approve, E to edit, R to reject. Control or Command and Enter schedules from the editor. Escape closes a panel. Single-key shortcuts can be turned off, and the choice is kept in this browser.

If a change fails, the page says what to do next. The technical detail stays behind a disclosure. Signing says how far through a batch you are only when more than one note is being signed.

Signing uses the browser signer on this page, or a paired bunker. Threads are signed root first. The bunker session stays in the OS keychain. The pairing code stays hidden until you ask for it. Test and demo runs keep that session in memory so they do not need a keychain.

## Demo with a mock signer and a local relay

This path uses a throwaway key and an in-process relay. It does not touch a real identity and it does not connect to a public relay.

```bash
pnpm install
pnpm demo:local
```

The demo resets `data/demo` on every run. It drives a clock so you can see three outcomes without waiting.

1. The local relay listens on `127.0.0.1`.
2. Three notes are suggested from the example criteria, approved, and signed with `created_at` set to each fire time.
3. The note inside the catch-up window is published. `sent-on-relay yes`.
4. A later note stays queued. `future-on-relay no`.
5. A note outside the catch-up window is marked missed and is not sent. `missed-on-relay no`.

A second run is safe. It clears the demo directory and produces a new event id.

`pnpm demo:harness` signs one kind-1 note, publishes it to the local relay, and reads it back. It prints `accepted <id>` and `read <id>`.

## Local relay

`pnpm relay:local` starts that same in-memory relay and leaves it running until Ctrl-C. It listens only on `127.0.0.1:7777`. It is a loopback test relay, and it never forwards an event to a real relay.

```bash
pnpm relay:local
```

The process prints `relay ws://127.0.0.1:7777`. Put that URL in the profile's relay list in `data/profiles.yaml`.

```yaml
    relays:
      - ws://127.0.0.1:7777
```

Each accepted event prints one line with its id, kind, and `created_at`. The note text is not printed. Events stay in memory and are lost when the process stops.

Change the port with `--port` or `NOSTR_SCHEDULER_RELAY_PORT`. The host stays `127.0.0.1`.

## Safety defaults

These are the v1 defaults. They are also listed in `DEFAULTS.md`.

- Catch-up window: 15 minutes (`NOSTR_SCHEDULER_CATCH_UP_SECONDS`). If the machine wakes 15 minutes or less after `created_at`, the publisher sends the event. If it is later than that, the event is marked missed and is not sent. Suggest it again and sign it with a new time. The old signed payload is not reused.
- Sign-ahead horizon: 7 days (`NOSTR_SCHEDULER_SIGN_AHEAD_SECONDS`). Signing refuses a `created_at` further ahead than that, and refuses a `created_at` in the past.
- Relays: each profile has a configured list. Reading that profile's NIP-65 list and merging write relays is optional and off by default. If that fetch fails, the configured list is used alone.
- Suggesters talk to the app over the local MCP server. The app does not embed a model and does not start a suggester of its own.
- MCP tools: `list_profiles`, `get_criteria`, `get_thread_context`, `suggest_post`, `list_queue`. There is no signing tool and no publishing tool.
- HTTP listeners bind `127.0.0.1` only.
- A signed event is frozen. To change the text or the time, discard it and sign again.
- The publisher never sends an event before its `created_at`.
- An item is marked sent when at least one target relay accepts it. Other relays are retried with backoff until the catch-up window ends. If none accept, the item is failed.
- Test and demo modes refuse any relay that is not on the loopback interface.
- Thread fire times must increase. Replies are signed after the root, because the root id has to exist first. The publisher sends the root first.

## Private key paste guard

If a note's text contains `nsec1` anywhere, in any case, the composer will not queue it. The same check refuses a draft, a suggestion, or an edit at the API, refuses `suggest_post`, and refuses to ask the signer. A thread is blocked when any post matches, including text inside a URL or another word. The marker does not have to be a valid key. The warning tells you to remove it and never repeats the pasted text.

## MCP

Start `node src/cli/main.ts mcp` and point a local MCP client at that process over standard input. A suggester can list profiles, read criteria and the decision log, read thread context, submit a suggestion, and inspect the queue. It cannot sign or publish.

`suggest_post` stores a suggestion. The suggester id has to match the one on the profile.

## Future work

If retracting a sent note is ever added, the UI calls it a deletion request.
