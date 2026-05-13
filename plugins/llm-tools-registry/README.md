# llm-tools-registry

Owns the in-memory tool registry and is the single chokepoint for tool execution. Any plugin can register a `(schema, handler)` pair; any consumer (driver, dispatch strategy, agent) lists or invokes them. All `tool:*` lifecycle events are emitted from one place — here — so observers see a uniform stream regardless of which dispatch strategy ran.

## What it does

- Maintains a `Map<name, { schema, handler, source }>` keyed by tool name. Insertion order is preserved.
- Tracks **provenance**: each registration carries a `ToolSource` — an open shape with a freeform `kind: string` and arbitrary structured metadata. `register(schema, handler)` defaults to `{ kind: "local" }`; `registerWith({ schema, handler, source })` lets callers supply their own. Well-known kinds: `local`, `mcp` (with `server: string`), `agent`, `skill`, `memory`. New kinds can be introduced by any registrar without editing the registry; consumers that present tools to users (e.g. `llm-codemode`) own their own bucket policy and fallback for unknown kinds.
- Validates registrations: `schema.name` must be a non-empty string; duplicate names throw (hot-swap = `unregister` then `register`).
- Returns a reference-scoped `unregister()` closure per registration. Idempotent. Will not remove a same-named replacement.
- `list(filter?)` snapshots schemas. Filters are AND-combined; `tags` is any-match against `schema.tags`. `listRegistrations(filter?)` returns the full `{ schema, handler, source }` records under the same filter rules.
- `invoke(name, args, ctx)` is the only execution path. It emits the full `tool:*` lifecycle and routes args through a mutable pre-execute hook so subscribers can rewrite or cancel.
- Honors a well-known cancellation sentinel: a `tool:before-execute` subscriber that sets `payload.args = CANCEL_TOOL` short-circuits the call. The handler is not invoked; `tool:execute` / `tool:result` are not emitted; `tool:error` is emitted; the promise rejects with an `AbortError`.
- Handler throws are caught: `tool:error` is emitted with the original error as `cause`, then the promise re-rejects with that same error.
- In-memory only. No persistence, no filesystem I/O, no network I/O. Concurrent `invoke` calls are independent; no per-invocation locks.

## Wiring

### Provides

**Service** — `tools:registry`

```typescript
interface ToolExecutionContext {
  signal: AbortSignal;
  callId: string;
  turnId?: string;
  sessionId?: string;
  log: (msg: string) => void;
}

type ToolHandler = (args: unknown, ctx: ToolExecutionContext) => Promise<unknown>;

interface ToolSource {
  kind: string;
  [k: string]: unknown;
}

interface ToolRegistration {
  schema: ToolSchema;
  handler: ToolHandler;
  source: ToolSource;
}

interface ListFilter {
  tags?: string[];
  names?: string[];
  sources?: ToolSource["kind"][];
}

interface ToolsRegistryService {
  register(schema: ToolSchema, handler: ToolHandler): () => void;
  registerWith(reg: ToolRegistration): () => void;
  list(filter?: ListFilter): ToolSchema[];
  listRegistrations(filter?: ListFilter): ToolRegistration[];
  invoke(name: string, args: unknown, ctx: ToolExecutionContext): Promise<unknown>;
}
```

`ToolSchema`, `ToolCall`, `ChatMessage`, `ToolsRegistryService`, `ToolHandler`, `ToolExecutionContext`, `ToolSource`, `ToolRegistration`, and `CANCEL_TOOL` are all part of the `tools:registry` contract and live in `llm-contracts/public`. Import from there. `CANCEL_TOOL`'s value is `Symbol.for("kaizen.cancel")`, so subscribers in unrelated plugins can also produce it inline without importing.

Semantics:
- `register()` claims a name. Re-registering a live name throws — call the returned `unregister()` first.
- `unregister()` is reference-scoped: if a different entry has taken the same name in the meantime, the closure does **not** remove the newer entry.
- `list()` and `listRegistrations()` return cloned arrays. Mutating the result does not mutate the registry.
- `invoke()` always emits at least one `tool:*` event. Even unknown-tool lookups emit `tool:error` before rejecting.
- `ctx.signal` is honored cooperatively by handlers; the registry does not race the handler against the signal.

### Slash commands

When `slash:registry` is available in the harness, this plugin registers:

- `/tools:list` — list registered tools grouped by source (`local` first, then `mcp:<server>`, etc.).
- `/tools:show <name>` — print the full schema for one tool.

Slash registration is deferred to `harness:start` so the optional `slash:registry` dependency is resolved without forcing a setup-order edge. Commands are torn down on `harness:end`. If `slash:registry` is absent, registration is skipped silently.

### Consumes

**VOCAB** — `events:vocabulary`. Provides the canonical event names. This plugin emits the events declared there but does not define them. Contract types (`ToolSchema`, `ToolCall`, `ChatMessage`, `CANCEL_TOOL`) come from `llm-contracts/public`.

### Events emitted

`tool:*` payloads carry `callId` (from `ctx.callId`) so subscribers can correlate events across concurrent invocations. When the caller's `ToolExecutionContext` includes `turnId` and/or `sessionId`, those fields are forwarded on every emitted event; when omitted, the fields are omitted from the payload.

- `tools:registered` — `{ name, source }`. Emitted from `register()` / `registerWith()`.
- `tools:unregistered` — `{ name, source }`. Emitted when the closure returned by `register*` runs and actually removes the entry (no-op for stale closures).
- `tool:before-execute` — `{ name, args, callId, turnId?, sessionId? }`. **Mutable payload.** Subscribers may reassign `payload.args` to rewrite arguments, or set `payload.args = CANCEL_TOOL` to abort the call. Awaited (sequential bus dispatch) before the registry reads the final args.
- `tool:execute` — `{ name, args, callId, turnId?, sessionId? }`. Informational, not mutable. Carries the post-mutation args.
- `tool:result` — `{ name, callId, result, durationMs, turnId?, sessionId? }`. Emitted on handler success.
- `tool:error` — `{ name, callId, message, cause?, durationMs?, turnId?, sessionId? }`. Emitted on unknown-tool, cancellation, and handler-throw paths. `cause` is the original error object on the throw path. `durationMs` is present for the handler-throw path only.

Event names are declared in the `llm-events` VOCAB (`TOOLS_REGISTERED`, `TOOLS_UNREGISTERED`, `TOOL_BEFORE_EXECUTE`, `TOOL_EXECUTE`, `TOOL_RESULT`, `TOOL_ERROR`); this plugin emits them but does not define them.

## Permissions

`tier: unscoped` — the registry holds arbitrary handlers from other plugins and exposes a mutation hook (`tool:before-execute`) that can rewrite tool arguments before execution. It performs no filesystem or network I/O of its own; the unscoped tier is for the surface area it brokers, not for direct access.
