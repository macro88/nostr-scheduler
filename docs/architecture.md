# Architecture

A local TypeScript program for composing and scheduling Nostr posts. One suggester per profile proposes posts against a criteria file. You review and sign them with your own signer. The app stores signed events and broadcasts each one at its `created_at`, never earlier.

## Constraints

- Zero custody of an account `nsec`. The process never asks for one and has no type that can hold one.
- You sign every post. The MCP server cannot sign or publish.
- A signed event is frozen. Changing the text or the time means discard and sign again.
- Relays reject events whose `created_at` is too far in the future. Pre-signed events stay local until fire time.
- v1 post types are short notes (kind 1), threads (kind 1 with NIP-10 root and reply tags), and replies to other people's posts.

## Modules

```
src/domain/        types, parsers, state transitions
src/criteria/      criteria files and the feedback log
src/profiles/      profile files
src/work/          SQLite inbox, queue, and publish log
src/signers/       NIP-07, NIP-46, and the NIP-55 refusal
src/publisher/     fire at created_at, retries, sent and failed
src/mcp/           loopback tool server
src/cli/           review, sign, publish, status
src/mock-signer/   the only module that may mint a throwaway account key
src/test-relay/    in-process relay for tests and the demo
```

The queue and the publisher depend on signed events and relay URLs. Criteria stay in files you can edit. The inbox, the queue, and the publish log stay in SQLite.

## Signing

Every adapter takes an unsigned kind-1 event and returns a signed one. Callers check the id, the signature, and that the payload still matches before the queue will store it.

- NIP-07. Node cannot see `window.nostr`. The app binds `127.0.0.1`, serves one page, and that page calls `window.nostr.signEvent`. The page has no field for a secret. If no signer is present, the page says so and the session fails.
- NIP-46. The profile stores a `bunker://` URI. During review the app talks to that bunker over the relays in the URI. A pairing secret in the URI is a connection token. The session key that encrypts that traffic is created in `src/signers/nip46-session.ts`. It is stored in the OS keychain. A mode `0600` file is used only after an explicit opt-in, and an old file is moved into the keychain and deleted. The connect request asks only for `sign_event` on kind 1.
- NIP-55. This is an Android intent flow. On a desktop the adapter refuses and tells you to use a bunker.

Batch signing walks approved items in order. A thread is signed root first. Each reply is built with the signed root id, then signed. `created_at` is the scheduled time.

## Lifecycle

`suggestion` to `approved` to `signed` to `queued`, then `sent`, `failed`, or `missed`.

A suggestion may be rejected. An approved, signed, queued, or failed item may be discarded. Missed and discarded items stay in the log. A replacement is a new suggestion with a new time. The old signed payload is not reused.

Transition functions accept only the legal starting state. The queue parses signed events at the boundary and will not store an event whose id or signature fails.

## Publisher

The publisher asks for queued items and, for each event, applies the catch-up rule in `DEFAULTS.md`.

- Before `created_at`, wait.
- Inside the window, publish to every configured relay.
- Past the window, mark the item missed and do not publish.

An item is `sent` when at least one relay accepts it. Relays that refuse are retried with backoff until the window ends. If none accept, the item is `failed`. The publisher never rewrites `created_at`.

Threads go out root first. A later event still waits for its own `created_at`.

## MCP

The server exposes exactly `list_profiles`, `get_criteria`, `get_thread_context`, `suggest_post`, and `list_queue`. A test fails if that list changes or if a tool name contains `sign` or `publish`. `suggest_post` writes a suggestion. It does not approve, sign, or enqueue. `list_queue` is read-only.

## Data on disk

```
data/profiles.yaml
data/criteria/<id>.md
data/criteria/<id>.feedback.yaml
data/app.sqlite
data/nip46/client.json    # only when file storage was explicitly opted in
```

The demo uses `data/demo/` and a throwaway key that is not written into that directory.
