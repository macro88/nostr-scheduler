# nostr-scheduler verification map

This directory is the maintained source for verifying nostr-scheduler from the terminal. Read the index before driving a command, then use the matching feature file as the recipe.

## Baseline preconditions

- Node 22 or newer, and dependencies installed with `pnpm install`.
- `node scripts/verify.mjs doctor` prints the package name and a Node version of 22 or newer.
- Each drive gets its own `NOSTR_SCHEDULER_DATA` under the system temp directory.
- The demo and harness set `NOSTR_SCHEDULER_MODE=demo`. Criteria validation does not.
- Never point a drive at a public relay or at a profile that is not the demo profile.
- Do not drive a data directory that this run did not create.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Treat every command as literal. Keep flags and quoted text unchanged.
- Run the helper with `node scripts/verify.mjs`.
- Run product commands with `pnpm` or `node src/cli/main.ts` from the repository root.
- Restore or delete scratch data after a mutation. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the command, stdout, stderr, and exit code.
- Mutation proof includes a second view of the stored result. For the demo, that view is the relay read-back line.
- Record the feature id and the entry point with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with the terminal` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Local demo](./local-demo.md) covers the mock signer, the local relay, a sent note, a held note, and a missed note.
- [Criteria validation](./criteria.md) covers a valid brief and a named field error.
- [Review commands](./review.md) covers status, approve, reject, and edit against an isolated data directory.
- [Relay harness](./harness.md) covers one signed note published to the local relay and read back.
- [Local UI](./ui.md) covers the inbox, composer, calendar, signing, and sent log in the browser.
