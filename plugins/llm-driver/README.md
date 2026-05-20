# llm-driver

Coordination plugin for the local harness. Owns the assistant turn loop, active session selection, cancellation, and the canonical conversation/turn/LLM lifecycle events. Persistent message storage lives in `llm-session-manager`.

## What it does

- Runs the interactive REPL: read input → emit `input:submit` → start turn → call LLM → render output → end turn.
- Tracks the active session id and writes messages through `sessions:store` turn handles. Cancellation/error rolls back buffered message writes.
- Owns turn identity (one `AbortController` per turn) and emits the lifecycle events other plugins observe (`harness:start`, `harness:end`, `harness:error`, `session:active-changed`, `turn:start`, `turn:end`, `turn:error`, `conversation:user-message`, `conversation:assistant-message`, `llm:before-call`, `llm:request`, `llm:token`, `llm:reasoning`, `llm:tool-call`, `llm:done`, `llm:error`).
- Cancellation: subscribes to `turn:cancel` and aborts the in-flight controller. On cancel, the current turn handle is *partially committed* — the user message and any completed tool roundtrips are persisted to the snapshot; a trailing assistant message with unresolved `toolCalls` is dropped. Non-abort errors still roll back fully.
- Short-circuit hooks for non-LLM input:
  - `input:handled` — subscriber sets a flag; the driver skips the LLM round-trip for the just-submitted line.
  - `harness:exit-requested` — flips a flag; the next loop iteration breaks out and ends the harness.
  - `session:active-changed` — updates the active session after `/clear`, `/session:new`, `/session:resume`, or active-session deletion.
  - `conversation:system-message` — bridges `{ message: { content } }` payloads to the UI's `writeNotice()` so slash-command output is visible.
- A-tier graceful degradation: if `tools:registry` and/or `dispatch:strategy` are absent, the loop runs a single LLM call and stops. With both present, runs the strategy/tool loop until `handleResponse()` returns no new messages.
- System-prompt resolution: when `prompt:registry` is bound, every LLM call's `systemPrompt` comes from `assemble()` with a generation-keyed cache (re-checked per turn). Otherwise it falls back to `input.systemPrompt` plus the strategy's `systemPromptAppend`.
- Exposes a recursive entry point via the `driver:run-conversation` service so other plugins can spawn nested/agent turns. Nested calls (when `externalTurnId` is supplied by the caller) do not own the outer `turn:start`/`turn:end`.
- After each interactive turn, posts a duration notice (`✻ <verb> for Ns`) using a randomized verb pool.

## Wiring

### Provides

**Service** — `driver:run-conversation`

```typescript
type RunConversationInput = {
  systemPrompt: string;
  sessionId: string;
  toolFilter?: { tags?: string[]; names?: string[] };
  model?: string;
  parentTurnId?: string;
  signal?: AbortSignal;
  trigger?: "user" | "agent";
} & (
  | {
      // Existing-turn mode, used by the interactive loop.
      externalTurnId: string;
      turnHandle: TurnHandle;
      userMessage?: never;
    }
  | {
      // Owned-turn mode. When omitted, the current snapshot tail must already
      // be a user message, such as a session:handoff seeded prompt.
      userMessage?: ChatMessage;
      externalTurnId?: never;
      turnHandle?: never;
    }
);

interface RunConversationOutput {
  finalMessage: ChatMessage;
  usage: { promptTokens: number; completionTokens: number };
}

interface DriverService {
  runConversation(input: RunConversationInput): Promise<RunConversationOutput>;
}
```

`llm-driver/public` re-exports `ToolDispatchStrategy` and `ToolDispatchRegistry` from `llm-contracts/public` for the optional `dispatch:strategy` extension point. Dispatch plugins implement the strategy; registry plugins provide the invoke surface the driver passes into the strategy.

Semantics:
- The driver does not select a model. If `input.model` is omitted, the LLM provider behind `llm:complete` substitutes its own default.
- `sessionId` selects the persisted transcript. The driver reads fresh messages from `sessions:store` before each LLM call and appends assistant/tool messages through a turn handle.
- In owned-turn mode (`userMessage` or a snapshot tail that already ends in a user message), `runConversation()` begins, commits, and rolls back its own turn and emits `turn:start`/`turn:end`.
- In existing-turn mode (`externalTurnId` plus `turnHandle`), the caller owns turn lifecycle and commit/rollback; `runConversation()` only appends messages.
- `signal` aborts the in-flight LLM stream. On abort, `turn:end` fires with `reason: "cancelled"`.

### Required Services

- **Service** — `events:vocabulary` (required). Event vocabulary plugin; the driver participates in the shared event names.
- **Service** — `ui:channel` (required). UI channel with `readInput()`, `setBusy()`, `writeOutput()`, `writeNotice()`, and optional `writeUser()`. Drives the interactive loop.
- **Service** — `llm:complete` (required). The provider that yields `LLMStreamEvent`s (`token`, `reasoning`, `tool-call`, `done`, `error`).
- **Service** — `sessions:store` (required). Persistent session store used for active transcripts and turn handles.

### Optional Services

These are discovered at runtime with safe `useService()` lookups rather than declared as hard `services.consumes` edges, so a smaller harness can omit them.

- **Service** — `tools:registry` (optional). When present, listed tools are advertised to the strategy via `prepareRequest({ availableTools })`.
- **Service** — `dispatch:strategy` (optional). When present together with `tools:registry`, drives the multi-step tool loop. `prepareRequest()` may return `tools` and a `systemPromptAppend`; `handleResponse()` returns messages to append before the next LLM call (empty array → end of turn).
- **Service** — `prompt:registry` (optional). When bound, supersedes both `input.systemPrompt` and `strategy.systemPromptAppend` for every LLM call. Cache is keyed on `generation()`; no `prompt:rebuilt` subscription is needed.

### Events emitted

Harness: `harness:start`, `harness:end`, `harness:error`.

Session: `session:active-changed { from, to }` when the driver creates the initial active session.

Turn: `turn:start { turnId, sessionId, trigger, parentTurnId? }`, `turn:end { turnId, sessionId, reason: "complete" | "cancelled" | "error", durationMs? }`, `turn:error { turnId, sessionId, message, cause }`.

Conversation: `conversation:user-message { message }`, `conversation:assistant-message { message }`.

LLM: `llm:before-call { request, turnId, sessionId }`, `llm:request { request, turnId, sessionId }` (frozen deep clone), `llm:token { delta, turnId, sessionId }`, `llm:reasoning { delta, turnId, sessionId }`, `llm:tool-call { toolCall, turnId, sessionId }`, `llm:done { response, turnId, sessionId, latencyMs }`, `llm:error { message, cause, turnId, sessionId }`.

Input loop: `input:submit { text }`.

All event names are owned by the `llm-events` VOCAB; this plugin emits them but does not define them.

### Events consumed

- `turn:cancel { turnId? }` — aborts the current turn. If `turnId` is supplied and does not match the current turn, the event is ignored.
- `conversation:system-message { message: { content } }` — surfaced to the UI as a notice.
- `input:handled` — sets a per-submit flag that suppresses the LLM round-trip.
- `harness:exit-requested` — breaks out of the input loop after the current iteration.
- `session:active-changed { to }` — updates the active session id.

### Hook into `llm:before-call`

Subscribers may mutate the request payload. Setting `request.cancelled = true` short-circuits the LLM call: the loop emits `turn:end` with `reason: "complete"` and returns the latest message as `finalMessage`.

## Configuration

Plugin config (read at `start()`):

| Key | Effect |
|-----|--------|
| `defaultSystemPrompt` | Used as the systemPrompt for the interactive loop when `prompt:registry` is not bound. Default: `""`. |

## Permissions

`tier: unscoped` — the driver coordinates other plugins; it does no I/O of its own beyond emitting events and calling consumed services.
