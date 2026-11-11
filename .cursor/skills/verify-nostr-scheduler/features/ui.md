# Local UI

The local UI is a browser page served with the API on `127.0.0.1`. It reviews suggestions, schedules posts, signs them, and shows what the local relay accepted.

## Sub-features

- `ui-inbox` edits, approves, and rejects suggestions.
- `ui-compose` schedules a two-post thread.
- `ui-calendar` shows the thread on the week grid.
- `ui-sign` signs approved posts with the browser signer.
- `ui-log` shows an accepted relay result after publish.

## How to get to it (user POV)

- Run `pnpm ui` and open `http://127.0.0.1:4173`.
- Run `pnpm test:e2e` for the scripted browser pass.

## Driving it with the terminal

Preconditions:

- `pnpm install` has completed.
- `pnpm exec playwright install chromium` has completed.
- `NOSTR_SCHEDULER_DATA` for a manual run points at a directory you created, with a profile whose relay is on `127.0.0.1`.

- **Scripted pass.** Run `pnpm test:e2e`. Exit code 0. The run uses a throwaway signer and a local relay.
- **Inbox.** Open the page, choose a suggestion, edit the text, approve it, and reject another with a reason. The inbox then says nothing is waiting, and the feedback file gains `rejected`.
- **Thread.** Open Compose, choose thread, fill both posts, set a time, and schedule. The week grid shows the root text.
- **Sign and publish.** Open Sign, choose Sign with browser, wait until the time, then choose Publish due on the calendar. The log shows `accepted` and `127.0.0.1`.
- **Proof.** Save the Playwright report or a screenshot of the log. The accepted line is the relay result, not only the button label.

## Gotchas

- The page refuses a host that is not loopback. Do not open it through another name.
- A signed item cannot be moved on the calendar. The page says to discard it and sign again.
- `pnpm ui` builds first. A failed build means the page is not serving the latest UI.
- The end-to-end run writes `e2e/run`. Delete that directory after a manual inspection. Do not point it at a real profile.
