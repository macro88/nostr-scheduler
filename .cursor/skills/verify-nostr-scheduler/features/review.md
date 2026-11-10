# Review commands

Review commands list suggestions, approve or reject them, and edit text that has not been signed yet.

## Sub-features

- `review-status` prints id, profile, and status for every stored item.
- `review-approve` moves a suggestion to approved and appends a feedback entry.
- `review-reject` moves a suggestion to rejected and stores the reason.
- `review-edit` replaces note text and appends an edited feedback entry.
- `review-frozen` refuses to edit a signed item.

## How to get to it (user POV)

- Run `node src/cli/main.ts --data <dir> status`.
- Run `node src/cli/main.ts --data <dir> approve <id>`.
- Run `node src/cli/main.ts --data <dir> reject <id> --reason "<text>"`.
- Run `node src/cli/main.ts --data <dir> edit <id> --content "<text>"`.

## Driving it with the terminal

Preconditions:

- A temp data directory contains `profiles.yaml`, a criteria file the profile points at, and `app.sqlite` with one suggestion created by `suggest_post` or by the test helper.
- The profile signer is not required for approve, reject, or edit.
- `node scripts/verify.mjs doctor` exits 0.

- **List.** Run `node src/cli/main.ts --data <dir> status`. Exit code 0 and stdout contains the suggestion id and the word `suggestion`.
- **Edit.** Run `node src/cli/main.ts --data <dir> edit <id> --content "A clearer claim."`. Exit code 0 and stdout is `suggestion`.
- **Approve.** Run `node src/cli/main.ts --data <dir> approve <id>`. Exit code 0 and stdout is `approved`.
- **Confirm the log.** Read `<criteria-dir>/<profile-id>.feedback.yaml`. It contains `edited` and `approved` for that suggestion id, and the criteria Markdown file is byte-for-byte unchanged.
- **Reject a second item.** Run the reject command with `--reason "no-go topic"`. Stdout is `rejected`.
- **Proof.** Run `status` again. The lines show `approved` and `rejected`. That second status view is the stored state.

## Gotchas

- Editing or approving a missing id exits 1 with `no item`.
- `sign` on a mock profile exits 1. The mock account key is not stored on disk. Use `pnpm demo:local` to exercise signing.
- A signed item cannot be edited. The command exits 1 and the event text in SQLite stays the same.
- Do not run review commands against `data/demo` while a demo is running. Give the drive its own directory.
