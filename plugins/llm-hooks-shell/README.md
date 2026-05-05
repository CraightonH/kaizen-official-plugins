# llm-hooks-shell

Optional declarative shell-command hooks bound to harness events. Reads a JSON config, subscribes to the named events, and spawns `sh -c <command>` each time one fires. For mutable events, a non-zero exit can cancel the operation.

## Do you want this?

Add it if you want declarative hooks for audit logging, notifications, or blocking gates on tool / codemode / LLM calls. Skip it if you don't already have a hook in mind — there is no built-in default and the permission tier is `unscoped`.

## Security warning

This plugin runs arbitrary shell commands with the harness's privileges. The permission tier is `unscoped` for that reason. Do NOT check `hooks.json` into a shared repo without review — a malicious hook can exfiltrate secrets or destroy data.

## What it handles

- Loads two config files and merges them (home first, then project; entries are concatenated, not deduped):
  - **Global:** `~/.kaizen/hooks/hooks.json`
  - **Project:** `<cwd>/.kaizen/hooks/hooks.json`
- Validates every `event` against the event vocabulary; refuses to start on unknown names.
- Subscribes to exactly the union of `event` values present in the merged config (no subscriptions when no hooks).
- For each event delivery, runs the matching hooks sequentially in config-file order (home before project).
- Flattens the event payload to `EVENT_<UPPER_SNAKE>` env vars (depth cap 4); always sets `EVENT_NAME` and `EVENT_JSON`.
- For mutable events with `block_on_nonzero: true`, a non-zero exit (or timeout) cancels the operation:
  - `tool:before-execute` → mutates `payload.args` to the cancellation sentinel and emits a `tool:error` carrying the hook's stderr.
  - `codemode:before-execute` → mutates `payload.code` to the cancellation sentinel.
  - `llm:before-call` → sets `payload.request.cancelled = true`.
  Failing hook also short-circuits remaining hooks for that event delivery.
- For non-mutable events, `block_on_nonzero` is ignored with a one-time setup warning.
- Default per-hook timeout is 30s, overridable via `timeout_ms`. Timeouts are treated identically to non-zero exits.
- Successful hook stdout is logged at `info`, one line per non-empty output line, prefixed with the event name. Failures are logged at `warn`. Hooks never crash the harness.
- Missing config files → no-op (no subscriptions, no log spam).

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

| Field | Required | Default | Notes |
|---|---|---|---|
| `event` | yes | — | Must exist in the event vocabulary. |
| `command` | yes | — | Passed to `sh -c` as a single string. |
| `cwd` | no | harness cwd | Working directory for the spawned shell. |
| `block_on_nonzero` | no | `false` | Only meaningful for `llm:before-call`, `tool:before-execute`, `codemode:before-execute`. |
| `timeout_ms` | no | `30000` | Enforced via the exec service's timeout. |
| `env` | no | `{}` | Extra env vars merged on top of the `EVENT_*` set. |

## Event payload → environment

Translation rules:

- Top-level scalar `→` `EVENT_<KEY>` with the string value.
- Top-level object/array `→` `EVENT_<KEY>` containing the JSON-encoded value, AND each leaf flattened with `_` separators (`request.model` → `EVENT_REQUEST_MODEL`).
- camelCase keys convert to UPPER_SNAKE (`turnId` → `TURN_ID`, `parentTurnId` → `PARENT_TURN_ID`).
- Recursion depth capped at 4. At the cap, only the JSON-encoded blob is set.
- `EVENT_NAME` always set to the event name.
- `EVENT_JSON` always set to the full payload JSON-encoded — escape hatch for fields the flattening missed.

Example: `turn:start { turnId: "t-7", trigger: "user" }` →

```
EVENT_NAME=turn:start
EVENT_TURN_ID=t-7
EVENT_TRIGGER=user
EVENT_JSON={"turnId":"t-7","trigger":"user"}
```

## Wiring

### Provides

Nothing. This plugin is a pure event consumer — it registers no services.

### Consumes

**Service** — `llm-events:vocabulary` (required). Used at setup time to validate the `event` field of every config entry. The plugin throws on unknown event names.

### Events subscribed

Dynamic — exactly the union of `event` values across the merged home + project configs. With no config files present, the plugin subscribes to nothing.

### Events emitted

- `tool:error` — `{ name, callId, message }`. Emitted when a `tool:before-execute` hook with `block_on_nonzero: true` fails or times out. The `message` carries the hook's stderr (`cancelled by hook: <stderr>`).

The plugin does not define this event; it emits the name owned by the event vocabulary.

## Differences from Claude Code's hooks

- v1 keys on event name only (no `tool_name` or regex matchers).
- Exit code is the only signal — stdout is logged but not parsed for payload mutation.
- Multiple hooks for the same event run sequentially in config-file order (home before project).

## Permissions

`tier: unscoped` — runs arbitrary shell commands. `exec.binaries: ["sh"]` is enforced; the user's `command` is run as `sh -c <command>`.
