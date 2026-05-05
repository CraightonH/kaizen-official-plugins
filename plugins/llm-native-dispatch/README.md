# llm-native-dispatch

Native OpenAI tool-calling dispatch strategy. Turns an LLM response containing structured `tool_calls` into executed tool invocations and the corresponding `tool` messages, so the driver's turn loop can keep going.

## What it does

- Provides a singleton `ToolDispatchStrategy` with `prepareRequest` and `handleResponse`.
- `prepareRequest({ availableTools })` → `{ tools: availableTools }`. Straight pass-through; no filtering, no `systemPromptAppend` (native dispatch relies on the provider's structured tool-calling, not prose).
- `handleResponse({ response, registry, signal, emit })`:
  - **No tool calls** → returns `[]`. Driver treats this as terminal; it has already appended the assistant text.
  - **One or more tool calls** → returns `[assistantMessage, toolMessage_1, …, toolMessage_N]` in order. The assistant message carries `toolCalls` and is included even when the driver streamed its content, because the OpenAI Chat Completions contract requires it to immediately precede the `tool` messages on the next request.
- Executes tool calls **sequentially** via `registry.invoke` (the registry is the sole execution chokepoint, so `tool:*` lifecycle events fire uniformly).
- Errors become `tool` messages, never thrown exceptions:
  - Unknown tool, handler throw, or cancellation → `content = JSON.stringify({ error: <message> })`.
  - Malformed `arguments` from the LLM (anything that isn't a plain object/array/`null`, or an `Error` sentinel) → skip `registry.invoke`, synthesize `{ error: "malformed arguments JSON from LLM", raw: <stringified> }`, emit `tool:error`, continue.
  - Result serialization: `string` passes through; `undefined`/`null` → `""`; anything else → `JSON.stringify`; circular structures fall back to `String(value)` and emit a `tool:error` with `"result not JSON-serializable, coerced to string"`.
- `signal` aborts mid-loop: stops invoking further tools and fills `{ error: "cancelled" }` `tool` messages for this and all remaining calls so the conversation stays well-formed.
- Per-invocation `ctx` carries `{ signal, callId: toolCall.id, log }`. `log(msg)` emits `status:item-update` with key `tool:<callId>`.

## Wiring

### Provides

**Service** — `tool-dispatch:strategy`

```typescript
interface ToolDispatchStrategy {
  prepareRequest(input: { availableTools: ToolSchema[] }):
    { tools?: ToolSchema[]; systemPromptAppend?: string };
  handleResponse(input: {
    response: LLMResponse;
    registry: ToolsRegistryService;
    signal: AbortSignal;
    emit: (event: string, payload: unknown) => Promise<void>;
  }): Promise<ChatMessage[]>;
}
```

The shared types (`ChatMessage`, `ToolSchema`, `LLMResponse`, `ToolsRegistryService`, `ToolExecutionContext`) come from the `llm-events` VOCAB; this plugin imports them but does not define them.

### Consumes

- **Service** — `tools:registry`. Required at runtime: `handleResponse` calls `registry.invoke(name, args, ctx)` for every tool call. The strategy never calls handlers directly, so all `tool:*` events flow uniformly through the registry.
- **VOCAB** — `llm-events:vocabulary`. Source of the shared type contracts.

### Events emitted

The strategy emits via the `emit` callback the driver hands it:

- `tool:error` — `{ name, callId, message }`.
  - Emitted directly when the LLM produces malformed `arguments` (the registry never sees the call).
  - Emitted directly when a tool result fails JSON serialization (`message: "result not JSON-serializable, coerced to string"`); the message content still goes through as `String(value)`.
  - **Not** re-emitted for unknown-tool / handler-throw / `CANCEL_TOOL` cancellation — the registry has already emitted those.
- `status:item-update` — `{ key: "tool:<callId>", value: msg }`. Bridged from each tool's `ctx.log`.

Both event names are owned by the `llm-events` VOCAB; this plugin emits them but does not define them.

## Permissions

`tier: trusted` — drives the registry, which executes arbitrary tool handlers.
