---
name: verify-nostr-scheduler
description: Prove nostr-scheduler from the terminal. Use when checking the local demo, criteria validation, review commands, or the relay harness.
---

# Verify nostr-scheduler

The app is a local CLI. There is no long-running server to keep open. A proof run installs dependencies once, then starts each drive in its own process with its own data directory.

## Launch

From the repository root, with Node 22 or newer:

```bash
pnpm install
```

Ready means `pnpm criteria:validate` prints `example 1` and exits 0. That command does not open a relay and does not sign anything.

Each drive sets `NOSTR_SCHEDULER_MODE=demo` only for the demo and harness commands. Leave it unset for criteria validation. Set `NOSTR_SCHEDULER_DATA` to a fresh directory under the system temp dir so two runs do not share SQLite or criteria files. Do not point a drive at `data/` for a real profile.

There is nothing to tear down while a drive is still starting. After a drive exits, run cleanup below.

## Doctor

Run this before a drive when anything looks off. It does not write the database and does not open a relay.

```bash
node scripts/verify.mjs doctor
```

Pass when the output shows Node 22 or newer, the package name `nostr-scheduler`, and an evidence directory. Fail when the Node major version is below 22.

## Drive

The helper is `scripts/verify.mjs`. Invoke it as `node scripts/verify.mjs <doctor|drive|cleanup>`.

`drive` runs `pnpm demo:local` with a throwaway data directory and writes the transcript under the evidence directory. The demo uses the mock signer and the in-process relay. It must not be given a public relay URL. Test and demo mode refuse one if it appears.

```bash
NOSTR_SCHEDULER_RUN_ID=run-1 node scripts/verify.mjs drive
```

Pass when the summary contains `sent-on-relay yes`, `future-on-relay no`, and `missed-on-relay no`, and the exit code file is `0`.

Other user paths, with the same isolation rules, are listed in `features/`. Drive the one you are proving. Do not treat a different command as a substitute for a path the map names.

## Evidence

Evidence lives in `$NOSTR_SCHEDULER_EVIDENCE/<run id>/`, or `/tmp/nostr-scheduler-verify/<run id>/` when that variable is unset. A drive writes `stdout.txt`, `stderr.txt`, `exit-code.txt`, `data-dir.txt`, and `summary.txt`.

A proof shows the command and the resulting state. For the demo, the resulting state is the three relay lines, not only the exit code. `sent-on-relay yes` is the read-back from the local relay. `future-on-relay no` and `missed-on-relay no` show what the publisher refused to send.

The demo resets its data directory, signs with an in-memory throwaway key, and publishes only to the relay it just bound on `127.0.0.1`. Confirm the summary's `relay` line is `ws://127.0.0.1:` and that stderr has no connection to any other host.

## Cleanup

```bash
NOSTR_SCHEDULER_RUN_ID=run-1 node scripts/verify.mjs cleanup
```

Cleanup deletes the data directory recorded in `data-dir.txt` when that path is under the system temp directory. It does not delete the evidence directory. It does not kill processes by name. The demo process has already exited when cleanup runs. If a drive is still running, stop that process id only.

After cleanup, `summary.txt` must still be readable.

## Helpers

`node scripts/verify.mjs doctor` prints the runtime check.

`node scripts/verify.mjs drive` runs the local demo and writes evidence.

`node scripts/verify.mjs cleanup` removes the scratch data directory and leaves the evidence in place.
