# claude-tui

Terminal UI for the claude-wrapper harness. Provides `ui:channel` (input/output/notices/setBusy) and renders a rounded "kaizen"-titled prompt box plus a status bar that subscribes to `status:item-update` events.

## Slash commands

- `/exit` — ends the session (equivalent to Ctrl-D).
- `/clear` — clears the terminal and re-renders.

## Permissions

Tier: `unscoped`. Reason: needs raw `process.stdin` and `process.stdout`.

## Development

```sh
bun install
bun test
```
