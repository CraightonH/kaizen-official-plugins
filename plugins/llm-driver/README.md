# llm-driver

Coordination plugin for the openai-compatible harness. Owns the assistant turn loop, the in-memory transcript, cancellation, and the canonical conversation/turn/llm lifecycle events.

## What it does

- Runs the interactive REPL: read input → emit `input:submit` → start turn → call LLM → render output → end turn.
- Maintains the in-memory message transcript across turns. Snapshots before each turn so cancellation/error rolls back cleanly.
- Owns turn identity (one `AbortController` per turn) and emits the lifecycle events other plugins observe (`turn:start`, `turn:end`, `turn:error`, `conversation:user-message`, `conversation:assistant-message`, `llm:before-call`, `llm:request`, `llm:token`, `llm:reasoning`, `llm:tool-call`, `llm:done`, `llm:error`, `session:start`, `session:end`, `session:error`).
- Cancellation: subscribes to `turn:cancel` and aborts the in-flight controller. On cancel, the transcript reverts to its pre-turn snapshot.
- Short-circuit hooks for non-LLM input:
  - `input:handled` — subscriber sets a flag; the driver skips the LLM round-trip for the just-submitted line.
  - `session:exit-requested` — flips a flag; the next loop iteration breaks out and ends the session.
  - `conversation:cleared` — wipes the transcript.
  - `conversation:system-message` — bridges `{ message: { content } }` payloads to the UI's `writeNotice()` so slash-command output is visible.
- A-tier graceful degradation: if `tools:registry` and/or `tool-dispatch:strategy` are absent, the loop runs a single LLM call and stops. With both present, runs the strategy/tool loop until `handleResponse()` returns no new messages.
- System-prompt resolution: when `prompt:system` is bound, every LLM call's `systemPrompt` comes from `assemble()` with a generation-keyed cache (re-checked per turn). Otherwise it falls back to `input.systemPrompt` plus the strategy's `systemPromptAppend`.
- Exposes a recursive entry point via the `driver:run-conversation` service so other plugins can spawn nested/agent turns. Nested calls (when `externalTurnId` is supplied by the caller) do not own the outer `turn:start`/`turn:end`.
- After each interactive turn, posts a duration notice (`✻ <verb> for Ns`) using a randomized verb pool.

## Wiring

### Provides

**Service** — `driver:run-conversation`

```typescript
interface RunConversationInput {
  systemPrompt: string;
  messages: ChatMessage[];
  toolFilter?: { tags?: string[]; names?: string[] };
  model?: string;
  parentTurnId?: string;
  signal?: AbortSignal;
}

interface RunConversationOutput {
  finalMessage: ChatMessage;
  messages: ChatMessage[];
  usage: { promptTokens: number; completionTokens: number };
}

interface DriverService {
  runConversation(input: RunConversationInput): Promise<RunConversationOutput>;
}
```

Semantics:
- The driver does not select a model. If `input.model` is omitted, the LLM provider behind `llm:complete` substitutes its own default.
- `messages` is treated as the starting transcript for the call; the returned `messages` is the full transcript including assistant (and any tool) messages appended during the call.
- When `parentTurnId` is supplied, the call is treated as a child turn. Each call emits its own `turn:start`/`turn:end` (unless the caller is the interactive loop, which owns those itself).
- `signal` aborts the in-flight LLM stream. On abort, `turn:end` fires with `reason: "cancelled"`.

### Consumes

- **Service** — `llm-events:vocabulary` (required). Event vocabulary plugin; the driver participates in the shared event names.
- **Service** — `llm-tui:channel` (required). UI channel with `readInput()`, `setBusy()`, `writeOutput()`, `writeNotice()`, and optional `writeUser()`. Drives the interactive loop.
- **Service** — `llm:complete` (required). The provider that yields `LLMStreamEvent`s (`token`, `reasoning`, `tool-call`, `done`, `error`).
- **Service** — `tools:registry` (optional). When present, listed tools are advertised to the strategy via `prepareRequest({ availableTools })`.
- **Service** — `tool-dispatch:strategy` (optional). When present together with `tools:registry`, drives the multi-step tool loop. `prepareRequest()` may return `tools` and a `systemPromptAppend`; `handleResponse()` returns messages to append before the next LLM call (empty array → end of turn).
- **Service** — `prompt:system` (optional). When bound, supersedes both `input.systemPrompt` and `strategy.systemPromptAppend` for every LLM call. Cache is keyed on `generation()`; no `prompt:rebuilt` subscription is needed.

### Events emitted

Session: `session:start`, `session:end`, `session:error`.

Turn: `turn:start { turnId, trigger, parentTurnId? }`, `turn:end { turnId, reason: "complete" | "cancelled" | "error", durationMs? }`, `turn:error { turnId, message, cause }`.

Conversation: `conversation:user-message { message }`, `conversation:assistant-message { message }`.

LLM: `llm:before-call { request, turnId }`, `llm:request { request }` (frozen deep clone), `llm:token { delta }`, `llm:reasoning { delta }`, `llm:tool-call { toolCall }`, `llm:done { response }`, `llm:error { message, cause }`.

Input loop: `input:submit { text }`.

All event names are owned by the `llm-events` VOCAB; this plugin emits them but does not define them.

### Events consumed

- `turn:cancel { turnId? }` — aborts the current turn. If `turnId` is supplied and does not match the current turn, the event is ignored.
- `conversation:cleared` — wipes the transcript.
- `conversation:system-message { message: { content } }` — surfaced to the UI as a notice.
- `input:handled` — sets a per-submit flag that suppresses the LLM round-trip.
- `session:exit-requested` — breaks out of the input loop after the current iteration.

### Hook into `llm:before-call`

Subscribers may mutate the request payload. Setting `request.cancelled = true` short-circuits the LLM call: the loop emits `turn:end` with `reason: "complete"` and returns the latest message as `finalMessage`.

## Configuration

Plugin config (read at `start()`):

| Key | Effect |
|-----|--------|
| `defaultSystemPrompt` | Used as the systemPrompt for the interactive loop when `prompt:system` is not bound. Default: `""`. |

## Permissions

`tier: unscoped` — the driver coordinates other plugins; it does no I/O of its own beyond emitting events and calling consumed services.
