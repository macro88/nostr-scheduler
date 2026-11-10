# Relay harness

The harness signs one kind-1 note with the mock signer, publishes it to the in-process relay, and reads that same id back.

## Sub-features

- `harness-accept` prints `accepted` and the event id.
- `harness-read` prints `read` and the same event id.

## How to get to it (user POV)

- Run `pnpm demo:harness`.

## Driving it with the terminal

Preconditions:

- `pnpm install` has completed.
- `node scripts/verify.mjs doctor` exits 0.
- The shell is not already exporting a relay URL.

- **Run the harness.** Run `pnpm demo:harness`. Exit code 0.
- **Compare the ids.** Stdout has two lines. The id after `accepted` equals the id after `read`.
- **Proof.** Save stdout. The second line is the relay read-back, not a repeat of the signer result from memory alone. The command exits non-zero if the relay body differs.

## Gotchas

- The npm script sets `NOSTR_SCHEDULER_MODE=demo`. Without that, the mock signer refuses to start.
- The relay port changes every run. Assert the id, not the port.
- This path publishes one note. It does not show the catch-up window. Use the local demo for held and missed notes.
