# llm-hooks-shell

Optional shell-command hooks for the openai-compatible harness. Reads
`~/.kaizen/hooks/hooks.json` and `<cwd>/.kaizen/hooks/hooks.json`, subscribes
to the named events, and runs the configured `sh -c` command when each fires.

## Do you want this?

Add it if you want declarative hooks for audit, notifications, or blocking
gates on tool/codemode/llm calls. Skip it if you don't already know what you'd
hook — there's no built-in default.

## Security warning

This plugin runs arbitrary shell commands with the harness's privileges. The
permission tier is `unscoped` for that reason. Do NOT check
`hooks.json` into a shared repo without review — a malicious hook could
exfiltrate secrets or destroy data.

## Schema

```json
{
  "hooks": [
    { "event": "turn:start", "command": "echo $EVENT_TURN_ID >> /tmp/audit.log" },
    { "event": "tool:before-execute", "command": "./check-tool.sh", "block_on_nonzero": true, "timeout_ms": 5000 },
    { "event": "turn:end", "command": "osascript -e 'display notification \"done\"'" }
  ]
}
```

Hook entries support `event`, `command`, optional `cwd`, optional
`block_on_nonzero` (only meaningful for mutable events: `tool:before-execute`,
`codemode:before-execute`), optional `timeout_ms` (default 30s), and optional
`env` (merged on top of the `EVENT_*` set).

## Event payload as environment

Top-level scalar keys become `EVENT_<UPPER_SNAKE>`. Objects/arrays are
JSON-encoded into the same key AND recursively flattened up to depth 4.
`EVENT_NAME` is always set to the event name; `EVENT_JSON` is always the
full payload as JSON. camelCase keys convert to UPPER_SNAKE
(`turnId` → `EVENT_TURN_ID`).

## Differences from Claude Code's hooks

- v1 keys on event name only (no `tool_name` or regex matchers).
- Exit code is the only signal — stdout is logged but not parsed for payload mutation.
- Multiple hooks for the same event run sequentially in config order
  (home file before project file).
