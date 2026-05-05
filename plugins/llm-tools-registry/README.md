# llm-tools-registry

Owns the in-memory tool registry and is the single chokepoint for tool execution. Any plugin can register a `(schema, handler)` pair; any consumer (driver, dispatch strategy, agent) lists or invokes them. All `tool:*` lifecycle events are emitted from one place — here — so observers see a uniform stream regardless of which dispatch strategy ran.

## What it does

- Maintains a `Map<name, { schema, handler }>` keyed by tool name. Insertion order is preserved.
- Validates registrations: `schema.name` must be a non-empty string; duplicate names throw (hot-swap = `unregister` then `register`).
- Returns a reference-scoped `unregister()` closure per registration. Idempotent. Will not remove a same-named replacement.
- `list(filter?)` snapshots schemas. Filters are AND-combined; `tags` is any-match against `schema.tags`.
- `invoke(name, args, ctx)` is the only execution path. It emits the full `tool:*` lifecycle and routes args through a mutable pre-execute hook so subscribers can rewrite or cancel.
- Honors a well-known cancellation sentinel: a `tool:before-execute` subscriber that sets `payload.args = CANCEL_TOOL` short-circuits the call. The handler is not invoked; `tool:execute` / `tool:result` are not emitted; `tool:error` is emitted; the promise rejects.
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
  log: (msg: string) => void;
}

type ToolHandler = (args: unknown, ctx: ToolExecutionContext) => Promise<unknown>;

interface ToolsRegistryService {
  register(schema: ToolSchema, handler: ToolHandler): () => void;
  list(filter?: { tags?: string[]; names?: string[] }): ToolSchema[];
  invoke(name: string, args: unknown, ctx: ToolExecutionContext): Promise<unknown>;
}
```

`ToolSchema` is re-exported from the `llm-events` VOCAB (Spec 0 owns it). The cancellation sentinel `CANCEL_TOOL` is also re-exported from this plugin's `public.d.ts`; its value is `Symbol.for("kaizen.cancel")`, so subscribers in unrelated plugins can produce it without importing this plugin.

Semantics:
- `register()` claims a name. Re-registering a live name throws — call the returned `unregister()` first.
- `unregister()` is reference-scoped: if a different entry has taken the same name in the meantime, the closure does **not** remove the newer entry.
- `list()` returns a cloned array. Mutating the result does not mutate the registry.
- `invoke()` always emits at least one `tool:*` event. Even unknown-tool lookups emit `tool:error` before rejecting.
- `ctx.signal` is honored cooperatively by handlers; the registry does not race the handler against the signal.

### Consumes

**VOCAB** — `llm-events:vocabulary`. Provides the canonical event names and the `ToolSchema` / `ToolCall` / `ChatMessage` types. This plugin emits the events declared there but does not define them.

### Events emitted

All payloads carry `callId` (from `ctx.callId`) so subscribers can correlate events across concurrent invocations.

- `tool:before-execute` — `{ name, args, callId }`. **Mutable payload.** Subscribers may reassign `payload.args` to rewrite arguments, or set `payload.args = CANCEL_TOOL` to abort the call. Awaited (sequential bus dispatch) before the registry reads the final args.
- `tool:execute` — `{ name, args, callId }`. Informational, not mutable. Carries the post-mutation args.
- `tool:result` — `{ name, callId, result }`. Emitted on handler success.
- `tool:error` — `{ name, callId, message, cause? }`. Emitted on unknown-tool, cancellation, and handler-throw paths. `cause` is the original error object on the throw path.

Event names are declared in the `llm-events` VOCAB (`TOOL_BEFORE_EXECUTE`, `TOOL_EXECUTE`, `TOOL_RESULT`, `TOOL_ERROR`); this plugin emits them but does not define them.

## Permissions

`tier: trusted` — the registry holds arbitrary handlers and exposes a mutation hook (`tool:before-execute`) that can rewrite tool arguments before execution.
