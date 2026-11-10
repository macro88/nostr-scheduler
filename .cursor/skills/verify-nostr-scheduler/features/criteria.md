# Criteria validation

Criteria validation reads one Markdown brief and either prints its profile id and version or names the field that failed.

## Sub-features

- `criteria-ok` accepts the example brief.
- `criteria-field` names `timezone` when the time zone is not an IANA name.

## How to get to it (user POV)

- Run `pnpm criteria:validate`.
- Run `node src/cli/main.ts criteria validate <file>`.

## Driving it with the terminal

Preconditions:

- `pnpm install` has completed.
- The example file `examples/criteria/example-profile.md` is unchanged.

- **Validate the example.** Run `pnpm criteria:validate`. Exit code 0 and stdout is `example 1`.
- **Force a field error.** Copy the example to a temp file, replace `Asia/Hong_Kong` with `Not/AZone`, and run `node src/cli/main.ts criteria validate <temp file>`. Exit code 1 and stderr contains `timezone`.
- **Proof.** Save both stdout and stderr. The success line is the parsed identity. The error line is the field name, which is the contract a caller branches on.

## Gotchas

- A missing heading fails the whole file. Do not delete a heading to make a partial file pass.
- `posts_per_day` is a target. The validator accepts `0`. It does not cap how many suggestions you approve.
- The example profile id is `example`. Loading it for a different profile id fails with `profile_id`.
