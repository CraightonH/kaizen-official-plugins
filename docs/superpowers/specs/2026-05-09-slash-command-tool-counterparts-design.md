# Slash Command Tool Counterparts

**Date:** 2026-05-09
**Status:** Design

## Goal

Give the LLM parity with the human user for inspecting and mutating kaizen at runtime, without duplicating capability surfaces or confusing the LLM with overlapping tools.

## Principle

> Every slash command gets a tool counterpart unless an existing tool already covers the same capability. The slash and tool handlers are thin adapters over a shared core (typically a service method). One direction only: slash → tool gap-fill. Tools without slash counterparts stay tool-only.

This generalizes for future commands: when a plugin adds a slash command, it adds a tool peer in the same file unless an existing tool already provides the capability.

## Architecture

```
Plugin
├── core/service          ← canonical implementation (existing)
├── slash-handler         ← thin adapter: free-form string args, prints output
└── tool-handler          ← thin adapter: JSON-schema args, returns structured value
```

**Invariants:**

- Both adapters call the same service method. Neither contains capability logic.
- Output shape divergence is expected and correct: slash adapter formats for humans via `ctx.print()`; tool adapter returns structured data from the handler.
- The shared core function returns structured data; only the slash adapter formats it.
- Tool name mirrors slash command name verbatim. `/session:list` → tool `session:list`. Colons pass through `mapTools()` unchanged (existing precedent: `mcp:github:search`).

## Refactor: move session built-ins out of `llm-slash-commands`

`llm-slash-commands/builtins.ts` currently registers `/clear`, `/session:new`, `/session:list`, `/session:resume`, `/session:rename`, `/session:delete` if `deps.sessions` is provided. This coupling is historical, not principled.

**Change:** delete those six registrations from `builtins.ts`. `llm-slash-commands` keeps `/help`, `/exit`, `/history` only.

**Land in:** `llm-session-manager` registers them itself, against `slash:registry` as a soft dependency (same pattern as `llm-mcp-bridge` and `llm-tools-registry`). Since `llm-session-manager` owns the canonical core, this is where both adapters belong.

**Side-effects:**

- `BuiltinDeps` shrinks (no more `sessions`, `getActiveSessionId`, `log`).
- `llm-slash-commands/index.ts` stops looking up `sessions:store`.
- Existing tests for the moved commands relocate with them.
- `slash:registry` is consumed soft (use the deferred-registration pattern from `llm-tools-registry`: register on `harness:start`).

## Tool peers

### `llm-session-manager`

| Tool name | Args (JSON schema) | Returns | Notes |
|---|---|---|---|
| `session:new` | `{}` | `{ from: string \| null, to: string, alias: string \| null }` | One tool covers both `/clear` and `/session:new` since they're functionally identical. Emits `session:active-changed` and `conversation:cleared` (matches `/clear` semantics). |
| `session:list` | `{ includeChildren?: boolean }` | `SessionRecord[]` | Raw `sessions.list()` output. |
| `session:resume` | `{ id_or_alias: string }` | `{ id: string, alias: string \| null }` | Same resolution logic as the slash command's `resolveSession()`. |
| `session:rename` | `{ name: string }` | `{ id: string, alias: string }` | Operates on the active session, mirroring the slash. |
| `session:delete` | `{ id: string, cascade?: boolean }` | `{ deleted: string, replacement?: string }` | Same active-session-replacement dance as the slash command. `replacement` is set when `id` is the active session. |

### `llm-mcp-bridge`

| Tool name | Args | Returns | Notes |
|---|---|---|---|
| `mcp:list` | `{}` | `ServerInfo[]` | Raw `bridge.list()` output. Distinct from the existing `list_mcp_resources` tool, which lists resources within one server. |
| `mcp:reload` | `{}` | `{ added: string[], removed: string[], updated: string[] }` | Re-reads config from disk and applies the diff. |
| `mcp:reconnect` | `{ server: string }` | `{ ok: true }` | Forces reconnect of one server. |
| `mcp:disable` | `{ server: string }` | `{ ok: true }` | Shuts down a server until next `mcp:reload`. |

## Audit (locked)

| Slash command | Action | Reason |
|---|---|---|
| `/help` | skip | Redundant with system-prompt tool catalog. |
| `/exit` | skip | TUI-only; no LLM use case. |
| `/history` | skip | TUI-only viewer. |
| `/clear`, `/session:new` | one tool (`session:new`) | Both functionally identical. |
| `/session:list` | tool | New `session:list`. |
| `/session:resume` | tool | New `session:resume`. |
| `/session:rename` | tool | New `session:rename`. |
| `/session:delete` | tool | New `session:delete`. |
| `/mcp:list` | tool | Distinct from `list_mcp_resources`. |
| `/mcp:reload` | tool | New `mcp:reload`. |
| `/mcp:reconnect` | tool | New `mcp:reconnect`. |
| `/mcp:disable` | tool | New `mcp:disable`. |
| `/tools:list`, `/tools:show` | skip | Redundant with system-prompt tool catalog. |

## Testing

Each plugin already has unit tests for its slash commands. Tool peers get parallel tests in the same style: register against a fake `tools:registry`, invoke, assert return shape and that the underlying service method was called.

**Required parity test per plugin:** one test that asserts slash and tool adapters produce equivalent observable side effects on the service for equivalent inputs. This catches drift if someone edits one adapter without the other.

Re-use existing fake-bus / fake-registry helpers in each plugin's `test/` dir.

## Out of scope

- **#4 (`/clear` with seed prompt for next session).** Separate spec. The `session:new` tool here returns the new session id and that's it. The seed-prompt flow needs its own design (how the LLM signals "I'm done, please pick this up next session"; how the seed prompt enters `input:submit` for the new session).
- **Tool → slash gap-fill.** One-direction principle. Tools without slash counterparts (`memory_save`, `memory_recall`, `load_skill`, agent dispatch) stay tool-only.
- **`/help`, `/tools:list`, `/tools:show`, `/exit`, `/history`.** See audit table.

## Implementation notes

- `llm-session-manager` doesn't currently consume `slash:registry` or `tools:registry`. Use the deferred-registration pattern from `llm-tools-registry`: register on `harness:start`, since `services.consumes` only orders peer setup and these registries may not be provided yet when this plugin's `setup()` runs. Tier bumps to `unscoped` (required for `ctx.on`).
- The session tool handlers must use the registry-supplied `ctx` (with its `signal`, `callId`) for cancellation; they cannot reach into the slash-command context.
- `mcp:reconnect` and `mcp:disable` translate the slash command's `ctx.args.trim()` arg parsing into a structured `{ server: string }` field. Empty-string handling moves from the slash adapter ("usage: /mcp:reconnect <server>") into JSON-schema validation (`required: ["server"]`).
- `session:rename` should preserve the slash command's `Rename failed: ...` error surfacing — for the tool, that means letting the underlying error propagate so the registry's `tool:error` event fires with the message.
