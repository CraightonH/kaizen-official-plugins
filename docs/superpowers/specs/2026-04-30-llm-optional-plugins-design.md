# LLM Optional Plugins — `llm-status-items` & `llm-hooks-shell` (Spec 12)

> **Note:** Config paths use the `~/.kaizen/<subdir>/` convention. See Spec 0 for rationale.

**Status:** draft
**Date:** 2026-04-30
**Depends on:** Spec 0 (`2026-04-30-openai-compatible-foundation-design.md`) — event vocabulary, `ChatMessage`/`LLMRequest`/`LLMResponse` shapes, `status:item-update` / `status:item-clear` payload contract.
**Scope:** Two small, optional, opt-in plugins for the C-tier harness. Both are pure event consumers — they register no services and do not appear in any service-dependency chain.

## Goal

Provide two ergonomic add-ons for users assembling a C-tier openai-compatible harness:

1. `llm-status-items` — visibility into the running session (model, token totals, turn state, optional cost estimate) via the existing TUI status bar.
2. `llm-hooks-shell` — power-user automation: declarative shell commands that fire on harness events, with optional blocking semantics for mutable events.

Both plugins are optional because they are opinionated:

- Status spam is not for everyone — minimalists prefer a quiet bar.
- Shell hooks execute arbitrary user code in the harness process tree; only users who want this should pay the permission cost.

Neither is required for chat, tool use, agents, skills, memory, or MCP. Excluding them from the harness file MUST NOT change any other plugin's behavior.

## Non-goals

- New event names. Both plugins consume the vocabulary defined in Spec 0; they do not extend it.
- New service interfaces. No service registration, no `ctx.provideService` calls.
- Persistent storage. Token counters and turn state are in-memory only; lifecycle matches the kaizen process.
- A general-purpose hook scripting language. `llm-hooks-shell` shells out — anything richer should be a real plugin.
- Mirroring Claude Code's full hook matcher grammar (regex matchers, `tool_name` matchers, etc.). v1 keys on event name only.

## Architectural overview

Both plugins follow the `claude-status-items` pattern (see `plugins/claude-status-items/index.ts`):

- `setup(ctx)` consumes `llm-events:vocabulary` and subscribes to a fixed list of events.
- All output is via `ctx.emit` (status items) or `ctx.exec.run` (shell hooks).
- No state machine outside what each plugin owns internally.

The status payload contract — `status:item-update { key, value }` and `status:item-clear { key }` — is authoritative per Spec 0. (The legacy `claude-status-items` plugin emits `{ id, content, priority }`; that vocabulary belongs to `claude-events`, not `llm-events`. The TUI plugin must accept both shapes via its claude/llm vocabulary adapter, but that is a TUI concern, not a concern for plugins in this spec.)

---

## Plugin 1: `llm-status-items`

### Responsibilities

Maintain four status-bar items, each updated reactively from the event bus. Every item has a stable `key` so the TUI can replace previous values in place.

| Key | Source events | Format | Notes |
|---|---|---|---|
| `model` | `llm:before-call` | model id string, e.g. `gpt-4.1-mini` | Updated each call. Captures overrides done by upstream subscribers (memory injection, agent overrides). |
| `tokens` | `llm:done`, `conversation:cleared` | `"<prompt>+<completion> = <total>"` | Accumulated session totals. Reset to zero on `conversation:cleared`. Emit `status:item-clear` when reset. |
| `turn-state` | `turn:start`, `llm:before-call`, `llm:done`, `tool:before-execute`, `tool:result`, `tool:error`, `turn:end` | `"thinking"` / `"calling <tool>"` / `"ready"` | See state machine below. |
| `cost-estimate` (v1, optional) | `llm:done`, `conversation:cleared` | `"$0.0123"` (USD, 4 decimals) | Computed from a per-model rate table; if model not in table, item is cleared rather than emitted as `$0`. |

### `turn-state` state machine

A tiny state machine fed by the events, emitted to the bar each transition:

- `turn:start` → `thinking`
- `llm:before-call` → `thinking` (idempotent — no-op if already thinking)
- `tool:before-execute { name }` → `calling <name>`
- `tool:result` / `tool:error` → `thinking` (next LLM call expected)
- `llm:done` with no further tool calls → `ready` if turn ended; otherwise stays `thinking` until next `tool:before-execute` or `turn:end`
- `turn:end` → `ready`

The cleanest way to drive this: maintain `turnInFlight: boolean` and `currentTool: string | null`; recompute the label after each event. Document this in the implementation as a single `recompute()` function.

### Cost estimate

Configuration shape (read at `setup` from `~/.kaizen/plugins/llm-status-items/cost-table.json`, missing file is fine):

```json
{
  "rates": {
    "gpt-4.1-mini": { "promptCentsPerMTok": 15,  "completionCentsPerMTok": 60 },
    "gpt-4.1":      { "promptCentsPerMTok": 200, "completionCentsPerMTok": 800 }
  }
}
```

On each `llm:done` with `usage` present and the active model in `rates`, increment `costCents` by `(prompt * pRate + completion * cRate) / 1_000_000` and emit. On `conversation:cleared`, reset to `0` and emit `status:item-clear` (or display `$0.0000` — pick one, document it).

If running fully local (no rate available for any model), the plugin SHOULD silently skip emitting `cost-estimate` rather than show a misleading `$0`.

### Subscriptions summary

```
llm:before-call
llm:done
turn:start
turn:end
tool:before-execute
tool:result
tool:error
conversation:cleared
```

### Permissions

```
tier: trusted
events: subscribe: [<list above>]
services: consumes: ["llm-events:vocabulary"]
```

`trusted` because the plugin only reads events and emits `status:*`. No filesystem writes (cost table is read-only and the read failure is silent), no exec, no network.

### Test plan

Unit (Bun test, harness-mocked `ctx`):

- Subscribes to exactly the eight events listed above; no others.
- `llm:before-call` updates `model` to the request's `model` field.
- Two consecutive `llm:done` events accumulate tokens (`100+50` then `300+150` → total `600`).
- `conversation:cleared` zeros tokens and emits `status:item-clear` for `tokens` (and `cost-estimate` if active).
- Turn-state transitions: `turn:start` → `thinking`; `tool:before-execute {name:"bash"}` → `calling bash`; `tool:result` → `thinking`; `turn:end` → `ready`.
- Cost: with a fixture rate table, two `llm:done` events produce the expected dollar string formatted to 4 decimals.
- Cost: model absent from rate table → no `cost-estimate` emission and any prior value is cleared.
- `model` value reflects post-mutation request (assert by emitting `llm:before-call` with a mutated `request.model` after a hypothetical memory plugin's mutation).

---

## Plugin 2: `llm-hooks-shell`

### Responsibilities

Read a JSON config of `{ event, command, ... }` declarations. For each entry, subscribe to the named event and spawn the command when the event fires. Expose the event payload as environment variables. For mutable events, allow the hook to cancel/mutate the operation through its exit code.

### Config file

Two locations, merged with project-local overriding home (entries are concatenated, not deduped — both can run):

- `~/.kaizen/hooks/hooks.json`
- `<cwd>/.kaizen/hooks/hooks.json`

Schema:

```ts
interface HookConfig {
  hooks: HookEntry[];
}
interface HookEntry {
  event: string;                    // any event name from llm-events VOCAB
  command: string;                  // passed to a shell (`sh -c`) as a single string
  cwd?: string;                     // default: harness cwd
  block_on_nonzero?: boolean;       // default: false; only meaningful for mutable events
  timeout_ms?: number;              // default: 30_000
  env?: Record<string, string>;     // extra env vars merged on top of the EVENT_* set
}
```

Example (matches the user-facing format from the request):

```json
{
  "hooks": [
    { "event": "turn:start", "command": "echo $TURN_ID >> /tmp/audit.log" },
    { "event": "tool:before-execute", "command": "./check-tool.sh", "block_on_nonzero": true }
  ]
}
```

### Event payload → environment translation

Payload object is flattened to `EVENT_<UPPER_SNAKE_KEY>` env vars. Non-string values are JSON-encoded.

Rules:

- Top-level scalar → `EVENT_<KEY>` with the string value.
- Top-level object/array → `EVENT_<KEY>` containing the JSON-encoded value, AND each leaf flattened with `_` separators (e.g. `request.model` → `EVENT_REQUEST_MODEL`).
- Camel-case keys converted to upper snake (`turnId` → `TURN_ID`, `parentTurnId` → `PARENT_TURN_ID`).
- Recursion depth capped at 4. Beyond that, only the JSON-encoded blob at the cap level is set.
- Always set `EVENT_NAME` to the event name (e.g. `turn:start`).
- Always set `EVENT_JSON` to the full payload JSON-encoded — the escape hatch for hooks that need fields the flattening missed.

Example: `turn:start { turnId: "t-7", trigger: "user" }` →

```
EVENT_NAME=turn:start
EVENT_TURN_ID=t-7
EVENT_TRIGGER=user
EVENT_JSON={"turnId":"t-7","trigger":"user"}
```

### Execution

- Spawn via `ctx.exec.run("sh", ["-c", entry.command], { cwd, env, timeoutMs })`.
- Capture stdout and stderr separately.
- On success (exit 0): log stdout at `info` (one line per non-empty output line, prefixed with the hook event); discard if empty.
- On non-zero exit OR timeout OR spawn failure: log stderr at `warn`. Do not crash the harness.
- Hooks run sequentially per event — multiple matching hooks for the same event fire in config-file order (home first, then project). This keeps blocking semantics deterministic.

### Blocking semantics (mutable events only)

The mutable events from Spec 0 are:

- `llm:before-call` — payload `{ request }`
- `tool:before-execute` — payload `{ name, args, callId }`
- `codemode:before-execute` — payload `{ code }`

For these events, if `block_on_nonzero: true` and the hook exits non-zero (or times out), the plugin MUST cancel the operation. v1 cancellation mechanism:

- `tool:before-execute` / `codemode:before-execute`: mutate `payload.args` (or `payload.code`) to a cancellation sentinel. Spec 0 already specifies that subscribers may set `args` to a sentinel to cancel. The exact sentinel value is a constant exported from `llm-events` (`TOOL_CANCEL_SENTINEL` / `CODEMODE_CANCEL_SENTINEL`); if Spec 0 has not yet defined it, this spec triggers the propagation rule from Spec 0 §"Spec 0 is the source of truth" — add the sentinel constants to `llm-events` first, then implement here.
- `llm:before-call`: mutate `payload.request` in-place to a flagged variant. Same propagation note applies — the cancellation mechanism for `llm:before-call` must be specified in Spec 0 (or in the `llm-driver` spec if the driver owns the check). Until then, `block_on_nonzero` is unsupported on `llm:before-call` and the plugin MUST fail config validation for that combination.
- For non-mutable events, `block_on_nonzero` is ignored with a one-time warning at `setup`.

The hook's stderr is included in the cancellation message logged to the bus (`tool:error` payload `message`) so the user can see why the hook blocked.

### Timeouts

Default 30 s per hook. Configurable per entry via `timeout_ms`. Timeout is enforced by `ctx.exec.run`'s `timeoutMs`. Timeout treated identically to non-zero exit for blocking purposes.

### Concurrency

Hooks for the same event fire sequentially within a single event delivery. Hooks for different events are independent (the bus may deliver them concurrently if events overlap). The plugin does not serialize across events — that would be a global bottleneck.

### Permissions

```
tier: unscoped
exec: { binaries: ["sh"] }       # enforced; entry.command is run via sh -c
fs:   { read: [<config paths>] } # for the two config files
events: subscribe: [<dynamic — every event present in the merged config>]
services: consumes: ["llm-events:vocabulary"]
```

`unscoped` because the user supplies arbitrary shell commands. The harness file MUST surface this in the marketplace listing — this plugin is opt-in for a reason.

If neither config file exists, the plugin loads as a no-op with an `info` log line and registers no subscriptions. This keeps the unscoped permission grant cheap when no hooks are configured.

### Subscriptions summary

Computed at `setup` from the union of `event` values in the merged config. The plugin MUST validate every event name against `VOCAB` from `llm-events:vocabulary` and refuse to start (logging the offending entry) if any event is unknown — better than silently dropping hooks.

### Test plan

Unit:

- Config parsing: empty file → no subscriptions; malformed JSON → `setup` rejects with a clear error.
- Config merge: home + project both present → entries appear in home-first order; project-only or home-only also work.
- Unknown event name in config → `setup` throws with the entry surfaced in the message.
- Env-var translation: `turn:start { turnId: "t-7", trigger: "user" }` produces exactly `EVENT_NAME`, `EVENT_TURN_ID`, `EVENT_TRIGGER`, `EVENT_JSON` as documented.
- Env-var translation: nested payload (`llm:before-call { request: { model: "gpt-4.1", messages: [...] } }`) produces `EVENT_REQUEST_MODEL` and an `EVENT_REQUEST_MESSAGES` JSON blob.
- Env-var translation: depth cap at 4 — fixture with depth 6 produces a JSON blob at depth 4 and no further `EVENT_*` keys for deeper leaves.
- camelCase → UPPER_SNAKE: `parentTurnId` → `EVENT_PARENT_TURN_ID`.
- Successful hook (exit 0, stdout=`"ok\n"`) → stdout logged at info; no warning.
- Failing hook (exit 1) without `block_on_nonzero` → stderr logged at warn; operation NOT cancelled.
- Failing hook on `tool:before-execute` with `block_on_nonzero: true` → `args` mutated to the cancel sentinel; subsequent `tool:execute` is suppressed by the registry; `tool:error` carries the hook's stderr.
- Timeout: hook that sleeps longer than `timeout_ms` is killed; treated as failure; if blocking, cancels the operation.
- `block_on_nonzero` on a non-mutable event (`turn:end`) → warning at setup; runtime ignores the flag.
- `block_on_nonzero` on `llm:before-call` while sentinel mechanism is unspecified in Spec 0 → config validation fails at setup.
- Multiple hooks on the same event run in config order; a blocking failure on hook #1 short-circuits hooks #2+.
- No config files present → plugin is a no-op with a single info log line.

Integration (against a mocked driver harness):

- Configure a `tool:before-execute` blocker that exits 1 → run a turn that would invoke a tool → tool is not executed; turn proceeds with the cancellation message in the conversation.
- Configure a `turn:start` audit hook → run a turn → audit file contains the turn id.

---

## Harness composition

Neither plugin appears in the default A/B/C-tier harnesses. Users opt in by appending to `harnesses/openai-compatible.json`:

```
official/llm-status-items
official/llm-hooks-shell
```

Order does not matter. Both depend only on `llm-events` (already present in every tier).

## Documentation requirements

Each plugin's `README.md` MUST include:

- A one-paragraph "do you want this?" framing — when to add it, when to skip it.
- For `llm-hooks-shell`: a security warning callout (unscoped exec, runs with the harness's privileges, do not check `hooks.json` into a shared repo without review).
- A worked example (minimum: status bar screenshot snippet for status-items; a 3-hook config for hooks-shell covering audit, blocking gate, and notification).

## Acceptance criteria

- Both plugins build, pass tests, and publish to the marketplace catalog with the permission tiers above.
- A C-tier harness with neither plugin behaves identically (event-trace and tool-output equivalence) to the same harness with both plugins added — modulo the new status-bar items and the hooks' side effects.
- `llm-hooks-shell` validates every config event name against `VOCAB` and refuses to start on unknown names.
- The cancellation sentinels referenced by `llm-hooks-shell` are defined in `llm-events` (propagation through Spec 0 if not already present); `tool:before-execute` blocking has a verified end-to-end test in the C-tier integration suite.
- Marketplace `entries` updated for `llm-status-items` and `llm-hooks-shell`.

## Open questions

- Should `llm-hooks-shell` support a `matcher` field (regex on event payload) à la Claude Code's `tool_name`? Deferred to v2 — v1 keys on event name only.
- Should `cost-estimate` ship a default rate table for popular OpenAI models, or stay BYO? Default off, BYO file. Reasoning: rates change; shipping a stale table is worse than shipping none.
- Should hook stdout be parsed (e.g. JSON output mutating the payload) the way Claude Code's hooks can? Out of scope for v1 — exit code is the only signal. Document this gap so users coming from Claude Code know the difference.
