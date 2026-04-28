# claude-driver

Session driver for the claude-wrapper harness. Spawns the local `claude` CLI in headless stream-json mode per turn, parses the NDJSON stream, fans text deltas out to `ui:channel`, and emits `llm.model` / `llm.context` status items.

## Behavior per turn

1. Reads a line of input via `ui:channel.readInput()`.
2. Spawns `claude -p <prompt> --output-format stream-json --verbose --include-partial-messages` (with `--continue` after the first turn).
3. Streams `text_delta` events to `ui.writeOutput`.
4. Emits `status:item-update` for `llm.model` (from `system/init`) and `llm.context` (from `result`).
5. Emits `turn:after` with token counts.
6. Guards against the known [#25629](https://github.com/anthropics/claude-code/issues/25629) hang bug: 2s grace → SIGTERM → SIGKILL.

Subscribes to `turn:cancel`; SIGINTs the active child when fired.

## Requirements

- The `claude` binary must be on `$PATH`.
- The user must already be logged in via `claude` (Pro/Max/Team/Enterprise OAuth, or API key).

## Permissions

Tier: `unscoped`. Reason: needs `child_process.spawn` and stdio stream access.

## Development

```sh
bun install
bun test
```
