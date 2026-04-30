# LLM Tools Registry & Native Dispatch — Design (Spec 4)

**Status:** draft
**Date:** 2026-04-30
**Scope:** Two tightly coupled Tier 2 plugins: `llm-tools-registry` (the in-memory `(schema, handler)` store and single tool-execution entry point) and `llm-native-dispatch` (a `tool-dispatch:strategy` provider that maps OpenAI-style native tool calling onto the registry). Both plugins implement contracts defined in Spec 0; this spec only fills in behavior, lifecycle, and edge cases.

**Reads-first:** [`2026-04-30-openai-compatible-foundation-design.md`](./2026-04-30-openai-compatible-foundation-design.md). All shared types (`ChatMessage`, `ToolCall`, `ToolSchema`, `ToolsRegistryService`, `ToolDispatchStrategy`, etc.) and event names (`tool:before-execute`, `tool:execute`, `tool:result`, `tool:error`) come from Spec 0 and are authoritative there. If anything in this spec disagrees with Spec 0, Spec 0 wins; follow the propagation rule in Spec 0.

## Goal

Provide the two plugins that, together with `llm-driver` and `openai-llm`, bring Tier 2 (B-milestone) tool-calling to working state:

1. A registry where any plugin can `register` a tool and any consumer (driver, dispatch strategy, agent) can `list` / `invoke` it, with the registry as the sole place that emits the `tool:*` lifecycle events.
2. A native-style dispatch strategy that turns an LLM response containing OpenAI `tool_calls` into executed tool invocations and the corresponding `tool` messages, so the driver's loop can keep going.

## Non-goals

- Code-mode dispatch — separate spec (`llm-codemode-dispatch`).
- Bundled tool implementations (filesystem, shell, etc.) — separate spec (`llm-local-tools`).
- Persistence of registered tools across sessions. The registry is in-memory only; plugins re-register on every `setup`.
- Permission gating beyond the plugin tier. Per-tool ACLs, prompts, and approval flows are out of scope here.
- Wire-format translation to/from OpenAI HTTP shape. The native dispatch strategy hands `ToolSchema[]` straight through; `openai-llm` is responsible for mapping `ToolSchema` to OpenAI's `{type:"function", function:{...}}` shape and for parsing `tool_calls` back into `ToolCall[]` with `arguments` already JSON-parsed.
- Streaming partial tool calls. By the time `handleResponse` is called, the response is complete (per Spec 0 `LLMResponse`).

## Architectural overview

```
              register / list / invoke
   plugins  ───────────────────────────►  llm-tools-registry
                                                │
                                                │ emits tool:* events
                                                ▼
                                          (event bus)
                                                ▲
                                                │ subscribes (TUI, logging…)
                                                │
   llm-driver ──── prepareRequest ──►  llm-native-dispatch
              ◄── handleResponse ────         │
                                              │ registry.invoke(name, args, ctx)
                                              ▼
                                        llm-tools-registry
```

The registry is the single chokepoint for execution. The dispatch strategy never invokes a handler directly — it always goes through `registry.invoke` so the lifecycle events fire uniformly regardless of which strategy is active (native today, code-mode tomorrow).

## Plugin 1: `llm-tools-registry`

### Plugin shape

Mirrors `plugins/claude-events/index.ts`:

- `name: "llm-tools-registry"`
- `apiVersion: "3.0.0"`
- `permissions: { tier: "trusted" }` — registry holds handlers, can rewrite args via events; trusted is required.
- `services: { provides: ["tools:registry"], consumes: ["llm-events:vocabulary"] }`
- `setup(ctx)` defines and provides the `tools:registry` service. Internal state is a `Map<string, { schema, handler }>` closed over by the service object.

### Service surface

Type defined in Spec 0 (`ToolsRegistryService`). Behavioral contract:

#### `register(schema, handler) → unregister`

- Validates `schema.name` is a non-empty string. If a tool with the same name is already registered, **throw** — duplicate registration is a programmer error, not a recoverable condition. (Hot-swap is achieved by calling the prior `unregister` first.)
- Stores the entry in the map.
- Returns a closure `() => void` that removes that exact entry. Calling the closure twice is a no-op. If a different entry has taken the same name in the meantime, the closure does **not** remove the newer entry (it identifies entries by reference, not name).
- Plugins MUST call their unregister functions in their `teardown` hook so reloads are clean.

#### `list(filter?) → ToolSchema[]`

- No filter → snapshot of all schemas (cloned array, not a live view).
- `filter.tags` (string[]) → tools whose `schema.tags` intersect the filter (any-match, not all-match).
- `filter.names` (string[]) → tools whose `schema.name` is in the set.
- Both filters → AND semantics (both must match).
- Order: insertion order. Deterministic so prompts/logs are stable.

#### `invoke(name, args, ctx) → Promise<unknown>`

The single execution path. Sequence:

1. Look up the entry by `name`. If missing, **emit `tool:error`** with `message: "unknown tool: <name>"` and reject the promise with the same error. (Do NOT emit `tool:before-execute` — there is nothing to cancel.)
2. Emit `tool:before-execute` with `{ name, args, callId: ctx.callId }`. The payload is **mutable**: subscribers may
   - reassign `payload.args` to rewrite arguments before execution, or
   - reassign `payload.args` to the cancellation sentinel `Symbol.for("kaizen.cancel")` to abort this invocation.
   The registry awaits all subscribers (the bus's normal sequential dispatch is sufficient) before reading the final `args`.
3. If `payload.args === Symbol.for("kaizen.cancel")`, emit `tool:error` with `{ message: "cancelled by subscriber" }` and reject with an `AbortError`-style error. Do not call the handler. Do not emit `tool:execute` or `tool:result`.
4. Emit `tool:execute` with the (possibly mutated) `{ name, args, callId }`. This event is informational, not mutable.
5. Await `handler(args, ctx)`.
   - On success: emit `tool:result` with `{ name, callId, result }` and resolve with `result`.
   - On throw: emit `tool:error` with `{ name, callId, message: String(err.message ?? err), cause: err }` and re-reject with the original error.
6. `ctx.signal` is honored cooperatively by the handler. The registry itself does not race the handler against the signal — handlers that need to abort listen to `ctx.signal` and reject themselves. (Rationale: the registry can't know how to safely interrupt arbitrary handler work.)

#### Concurrency

Multiple `invoke` calls may be in flight simultaneously (code-mode in particular fans out tool calls). Each call gets its own `callId` (provided by the caller) and its own event sequence. The registry holds no per-invocation locks; the handler is responsible for its own concurrency model.

The `tool:before-execute` mutation pattern is per-call: subscribers see one payload per invocation, so concurrent calls are independent.

### Cancellation sentinel

Exported as a constant from the plugin's `public.d.ts`:

```ts
export const CANCEL_TOOL: unique symbol;  // value: Symbol.for("kaizen.cancel")
```

Documented as the only supported way for a `tool:before-execute` subscriber to abort an invocation. The well-known `Symbol.for` key means subscribers in other plugins can refer to the same sentinel without importing this plugin.

### Tests

Unit tests for `llm-tools-registry`:

- `register` then `list` returns the schema; `unregister()` removes it.
- `register` of duplicate name throws.
- `unregister` is idempotent and does not remove a same-named replacement.
- `list({ tags })`, `list({ names })`, `list({ tags, names })` filter correctly; empty filter returns all.
- `invoke` of unknown tool emits `tool:error` and rejects.
- Successful `invoke` emits `tool:before-execute` → `tool:execute` → `tool:result` in order with matching `callId`.
- A `tool:before-execute` subscriber that mutates `args` causes the handler to see the mutated args and the `tool:execute` event to carry the mutated args.
- A subscriber that sets `args = CANCEL_TOOL` short-circuits: handler is not invoked, `tool:execute` is not emitted, `tool:error` is emitted, promise rejects.
- Handler throw emits `tool:error` and re-rejects with the original error.
- Two concurrent `invoke` calls with distinct `callId`s emit distinct event streams that do not interleave incorrectly (each call's `before-execute → execute → result` arrives in order).

## Plugin 2: `llm-native-dispatch`

### Plugin shape

- `name: "llm-native-dispatch"`
- `apiVersion: "3.0.0"`
- `permissions: { tier: "trusted" }` — calls into the registry which executes arbitrary tools.
- `services: { provides: ["tool-dispatch:strategy"], consumes: ["tools:registry", "llm-events:vocabulary"] }`

`setup(ctx)` provides a singleton `ToolDispatchStrategy` object. It does not need access to the registry at provide-time; the registry is passed in to `handleResponse`.

### `prepareRequest({ availableTools }) → { tools }`

- Returns `{ tools: availableTools }` — a straight pass-through. No filtering, no transformation. The driver has already applied any `toolFilter` from the caller before invoking `prepareRequest`.
- Does **not** populate `systemPromptAppend`. Native dispatch relies on the LLM provider's structured tool-calling support, not prose instructions.
- If `availableTools` is empty, returns `{ tools: [] }` (the `openai-llm` plugin will then omit the `tools` field from the wire request).

### `handleResponse({ response, registry, signal, emit }) → ChatMessage[]`

Behavior is the conversation-mutation contract that the driver depends on. The driver does:

```ts
const newMessages = await strategy.handleResponse({...});
messages.push(...newMessages);
if (newMessages.length === 0) break;  // terminal
```

So the returned array must be **everything that needs to be appended** to the running messages array, in order, including the assistant message itself.

#### Cases

**Case A — terminal (no tool calls).**

If `response.toolCalls` is undefined or empty:

- Return `[]`.
- The driver, seeing an empty array, treats this as the end of the turn. It is the driver's responsibility (not the strategy's) to append the assistant message it built from `response.content` — because in the terminal case the driver has already done that during streaming.

Rationale: Spec 0's `handleResponse` contract says "returns the messages that should be appended" and "Returns an empty array if the response was terminal". The driver appends the assistant message itself when there are no tool calls; the strategy only contributes additional messages required for tool execution.

**Case B — one or more tool calls.**

Return value is:

```
[ assistantMessage, toolMessage_1, toolMessage_2, ..., toolMessage_N ]
```

Where:

- `assistantMessage` is a `ChatMessage` with `role: "assistant"`, `content: response.content` (often empty when finish reason is `tool_calls`), and `toolCalls: response.toolCalls`. The strategy MUST include this — even if the driver already streamed the text — because the OpenAI Chat Completions contract requires the assistant message with `tool_calls` to immediately precede the corresponding `tool` messages on the next request. (Driver MUST NOT also append the assistant message itself in the non-terminal case; it relies on the strategy's return value to contain it. The driver detects "non-terminal" precisely by `newMessages.length > 0`.)
- One `toolMessage_i` per `toolCall_i` in the same order, with:
  - `role: "tool"`
  - `toolCallId: toolCall.id`
  - `name: toolCall.name`
  - `content: <serialized result or error>` (see below)

#### Execution semantics

Sequential, in the order `response.toolCalls` provided.

- Rationale: predictable for users, predictable for tests, predictable when one tool's side effects are intended to influence the next. Local LLMs frequently emit dependent tool calls in one response (e.g. `read_file` then `edit_file`); parallel execution would race.
- Cost: latency. For independent calls (e.g. multiple `read_file`s) the LLM pays N round-trips of handler latency instead of 1. We accept this; if benchmarks later show this is a real problem, we can introduce an opt-in `parallel: true` flag on the strategy without changing the public contract.
- `signal` is forwarded to each invocation's `ctx.signal`. If the signal aborts mid-loop, the strategy stops invoking further tools, serializes a "cancelled" tool message for any not-yet-invoked calls (so the conversation stays well-formed for the next LLM request), and returns. The driver, seeing the signal aborted, will end the turn with `reason: "cancelled"`.

#### Per-call invocation

For each `toolCall`:

```
ctx = { signal, callId: toolCall.id, log: (msg) => emit("status:item-update", { key: `tool:${toolCall.id}`, value: msg }) }
result = await registry.invoke(toolCall.name, toolCall.arguments, ctx)
toolMessage.content = serialize(result)
```

If `registry.invoke` rejects (unknown tool, handler throw, cancellation sentinel):

- Catch the rejection. Do not propagate.
- Build the `tool` message with `content = serialize({ error: err.message })` so the LLM sees the failure and can react on the next turn. This is the "error becomes a tool message, not a thrown exception" rule from the spec brief.
- Continue with the remaining tool calls (unless `signal.aborted`, see above).

The registry has already emitted `tool:error` for the failure; the strategy does not re-emit. (This is why the strategy still goes through `registry.invoke` for every call — to get uniform event emission.)

#### Result serialization

`tool` message `content` must be a string (OpenAI Chat Completions API constraint).

- `string` → used as-is.
- `undefined` / `null` → empty string.
- Anything else → `JSON.stringify(value)`. If `JSON.stringify` throws (circular ref), fall back to `String(value)` and emit a `tool:error` event with `message: "result not JSON-serializable, coerced to string"` so the issue is visible.
- For the error case above, the content is `JSON.stringify({ error: message })`.

#### Malformed `arguments` from the LLM

Per Spec 0, `ToolCall.arguments` is "already JSON-parsed" — the `openai-llm` plugin owns the parse. But local LLMs frequently emit malformed JSON, and `openai-llm` may surface this either by:

(a) rejecting the entire `complete` call with `finishReason: "error"`, or
(b) producing a `ToolCall` whose `arguments` is a string (the unparsed body) or an `Error` sentinel.

To cover (b), the native dispatch strategy treats any `toolCall.arguments` that is **not** a plain object/array/primitive as a malformed-arguments case:

- Skip `registry.invoke`.
- Synthesize an error tool message with `content = JSON.stringify({ error: "malformed arguments JSON from LLM", raw: <stringified arguments> })`.
- Emit `tool:error` with an explanatory message so observability still shows the failure.
- Continue to the next tool call.

This keeps a single bad tool call from killing the loop. The LLM will see the error in its next turn and (typically) retry with valid JSON.

The exact contract for what `openai-llm` puts in `arguments` on parse failure is a separate decision in Spec 1; this strategy is defensive against either form.

### Tests

Unit tests for `llm-native-dispatch`:

- `prepareRequest` returns `{ tools }` matching input.
- `handleResponse` with no tool calls returns `[]`.
- `handleResponse` with one tool call returns `[assistantMessage, toolMessage]`; the assistant message carries `toolCalls`; the tool message has matching `toolCallId`, `name`, and serialized result.
- `handleResponse` with three tool calls returns four messages in order; tools are invoked sequentially (use a counter in mocked handlers and assert ordering).
- A handler that throws produces a tool message with serialized error content; subsequent tool calls in the same response still execute.
- An unknown tool name produces a tool message with serialized error content.
- A tool call with malformed `arguments` (e.g. `arguments` is a string) skips `registry.invoke`, produces a malformed-args error tool message, and continues.
- Aborting `signal` mid-loop stops further `registry.invoke` calls; remaining tool calls receive a "cancelled" tool message; the returned array is still well-formed (assistant + N tool messages).
- Result serialization: string passes through, object is JSON-stringified, `undefined` becomes `""`.

## Lifecycle / interaction with the driver

- `llm-driver` resolves both services in `setup`: `tools:registry` (any consumer), `tool-dispatch:strategy` (selects one — for the B-tier native harness, it selects `llm-native-dispatch`'s instance).
- On each LLM call within a turn:
  1. Driver calls `strategy.prepareRequest({ availableTools: registry.list(filter) })`.
  2. Driver calls `llm:complete` with the strategy's contributions merged into the request.
  3. Driver calls `strategy.handleResponse({ response, registry, signal, emit })`.
  4. Driver pushes the returned messages onto its conversation array. If empty, the turn ends (the driver had already appended the final assistant message during streaming).
- `llm-tools-registry` subscribes to nothing on the bus. It only emits.
- `llm-native-dispatch` subscribes to nothing on the bus. It only invokes the registry and emits via the registry's events.

## Edge cases & failure modes summary

| Situation | Behavior |
|---|---|
| Duplicate `register` of same name | `register` throws (programmer error). |
| `unregister` called twice | Second call is a no-op. |
| `invoke` of unknown tool | `tool:error` emitted, promise rejects. |
| Subscriber cancels via `CANCEL_TOOL` sentinel | `tool:execute`/`tool:result` not emitted; `tool:error` emitted; promise rejects. |
| Handler throws | `tool:error` emitted; promise re-rejects with original error. |
| Handler returns non-string | Strategy JSON-stringifies for tool message content. |
| Handler returns circular structure | Strategy falls back to `String(value)` and emits `tool:error`. |
| LLM emits malformed `arguments` | Strategy synthesizes error tool message; loop continues. |
| LLM emits zero tool calls | Strategy returns `[]`; driver ends turn. |
| `signal` aborts mid-tool-loop | Strategy stops invoking; fills cancelled tool messages; returns. |
| Two concurrent `invoke` calls | Independent event streams; no shared locks. |

## Acceptance criteria

- Both plugins build under TypeScript strict mode and pass their own unit tests.
- `llm-tools-registry` exports `CANCEL_TOOL` from `public.d.ts` and the value equals `Symbol.for("kaizen.cancel")`.
- `tools:registry` service implements `ToolsRegistryService` from Spec 0 exactly; no additional methods on the public surface.
- `llm-native-dispatch` provides a `tool-dispatch:strategy` service whose object satisfies `ToolDispatchStrategy` from Spec 0 exactly.
- An end-to-end test in the B-tier harness (asserted in the `llm-driver` spec, not here): user prompt → LLM emits one tool call → registry executes → second LLM call sees the tool result → LLM emits final text. Driver, openai-llm, registry, and native-dispatch all participate; no plugin imports any other plugin's runtime code (only types from `public.d.ts`).
- Marketplace `entries` updated for both plugins.
- No persistence, no filesystem I/O, no network I/O in either plugin.

## Open questions

- **Parallel tool execution.** Sequential is the documented default. If, after Tier 2 ships, real workloads show meaningful latency wins from parallelism for independent calls, we add an opt-in `parallel?: boolean` flag to the strategy's construction (or a separate `llm-native-parallel-dispatch` plugin). Defer until evidence.
- **Cancellation sentinel ergonomics.** Using a `Symbol.for` key means any plugin can produce/check the sentinel without importing this plugin, at the cost of a stringly-typed contract. Alternative: a richer cancellation API on the event payload (e.g. `payload.cancel(reason)`). Defer; revisit if a real subscriber needs to convey a reason.
- **Per-tool permissions / approval prompts.** Out of scope for Tier 2. A future `llm-tool-approvals` plugin can subscribe to `tool:before-execute`, prompt the user via the TUI, and either let the call through or set the `CANCEL_TOOL` sentinel. The contract in this spec is designed to make that plugin possible without further changes.
- **Tool result size limits.** Local LLMs choke on huge tool outputs (e.g. an unfiltered `read_file`). Truncation policy is the tool implementation's concern (Spec for `llm-local-tools`), not the registry's. Open question whether the dispatch strategy should also enforce a hard cap as a safety net; deferred.
- **`openai-llm` malformed-args contract.** What exactly does the provider plugin put in `ToolCall.arguments` when JSON parsing fails? This spec is defensive against multiple forms; Spec 1 should pin one form and this spec should be tightened to match.
