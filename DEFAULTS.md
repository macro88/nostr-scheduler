# Defaults

v1 uses these choices where a product decision was still open. They can be changed later. They live in config, not in the type of an event.

## Catch-up window: 15 minutes

If the machine was asleep or offline at fire time, the publisher compares the clock with the event's `created_at` the next time it runs.

- If now is before `created_at`, wait. Never publish early.
- If now is at or after `created_at`, and the delay is 15 minutes or less, publish now.
- If the delay is greater than 15 minutes, do not publish. Mark the item missed so it can be suggested again with a new time. The old signed event is not reused.

Fifteen minutes matches the tighter common relay limit on future events. Relays generally accept past timestamps, but a note that arrives hours late still carries the original `created_at`. A late reply also lands in a conversation that has often moved on. Skipping and signing again is safer than sending a stale note.

The window is `NOSTR_SCHEDULER_CATCH_UP_SECONDS`. Replies use the same default. A shorter per-type window can be added later.

## Sign-ahead horizon: 7 days

A sign session refuses an event whose `created_at` is more than 7 days after now. It also refuses a `created_at` in the past.

Daily review is the expected rhythm. A seven-day ceiling covers a week away without locking a long run of frozen posts. Signed events cannot be edited, so a longer horizon would leave stale replies that can only be discarded.

The horizon is `NOSTR_SCHEDULER_SIGN_AHEAD_SECONDS`.

## Relays: configured list, optional NIP-65

Each profile has a non-empty configured relay list. That list is the publish target.

If `read_nip65` is true, the app may also fetch that pubkey's NIP-65 (kind 10002) list and merge write relays into the target set. This is off by default, including when the field is omitted, so a first run does not publish somewhere you did not configure. If the fetch fails, the configured list is used on its own.

There is no built-in public relay. The demo uses only the local test relay. Test and demo modes refuse a relay that is not on the loopback interface.

## Suggesters run over MCP

Suggesters run outside this process and call the local MCP tools. The app does not embed a model and does not start a suggester of its own.

## Related publisher rules

- An item is `sent` when at least one target relay accepts it. Other relays are retried with exponential backoff (1, 2, 4, 8, then 16 seconds) until the catch-up window ends.
- A relay response that reports a duplicate counts as accepted, so a retry after a crash does not turn a delivered event into a failure.
- If no relay accepts, the item is `failed`.
- Thread events publish in stored order, root first, each at its own `created_at`. If a later event in the thread is already outside the window, the item is marked missed and the remaining events are not sent.
- HTTP listeners bind `127.0.0.1` only.
- The demo resets `data/demo` at the start of each run.
