# Local demo

The local demo suggests three notes, signs them with a throwaway key, and publishes only the one whose fire time is inside the catch-up window.

## Sub-features

- `demo-relay` starts a relay on `127.0.0.1` and prints its URL.
- `demo-sent` publishes the due note and reads it back.
- `demo-future` leaves a later note queued and off the relay.
- `demo-missed` marks an overdue note missed and does not send it.
- `demo-repeat` runs a second time in the same data directory and still exits 0.

## How to get to it (user POV)

- Run `pnpm demo:local` from the repository root.
- Run `node scripts/verify.mjs drive` when a transcript should be kept.

## Driving it with the terminal

Preconditions:

- `node scripts/verify.mjs doctor` exits 0.
- `NOSTR_SCHEDULER_MODE` is unset in the shell before the helper sets it.
- No proof is required from a previous run.

- **Drive the demo.** Run `NOSTR_SCHEDULER_RUN_ID=local-demo node scripts/verify.mjs drive`. Exit code 0. Stdout contains `relay ws://127.0.0.1:`, `sent-on-relay yes`, `future-on-relay no`, and `missed-on-relay no`.
- **Confirm the transcript.** Read `/tmp/nostr-scheduler-verify/local-demo/summary.txt`. It repeats those three relay lines and `exit 0`.
- **Repeat.** Run `pnpm demo:local` twice with `NOSTR_SCHEDULER_DATA` set to the same empty directory. Both runs exit 0 and print different `sent` ids.
- **Proof.** Keep `summary.txt`. The `sent-on-relay yes` line is the relay read-back, and the other two lines are the events the publisher refused.

## Gotchas

- `pnpm demo:local` exits 1 unless `NOSTR_SCHEDULER_MODE=demo`. The npm script sets that. A bare `node src/demo/local.ts` does not.
- The demo resets its data directory at the start. A second run is safe because it does not reuse the previous signed payload.
- The clock in the demo is virtual. The command returns without sleeping for the fire time. The publisher code is the same code the `publish` command uses.
- A relay URL that is not loopback is a failed precondition. Do not edit the demo to point it at a public relay.
