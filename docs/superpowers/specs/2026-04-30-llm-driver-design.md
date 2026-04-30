# `llm-driver` — Coordination Plugin (Spec 2)

**Status:** draft
**Date:** 2026-04-30
**Scope:** The `llm-driver` plugin only. Owns the turn loop, conversation state, lifecycle event emission, cancellation, and the `driver:run-conversation` service. Tier-1 plugin in the openai-compatible harness ecosystem.

## Goal

Provide the single coordination surface for the openai-compatible harness. The driver is the only plugin that:

- Drives the assistant turn loop end-to-end.
- Owns conversation state across turns in the interactive (TUI) loop.
- Emits the lifecycle events defined in Spec 0 (`turn:*`, `conversation:*`, `llm:*`).
- Handles cancellation cleanly via `turn:cancel` + per-call `AbortSignal`.
- Exposes `driver:run-conversation` so other plugins (notably `llm-agents`) can recursively run conversations as nested turns.

The driver is provider-agnostic, dispatch-strategy-agnostic, and tool-registry-agnostic. All three are consumed via service interfaces from Spec 0; the driver works correctly when only `llm:complete` is present (A-tier graceful degradation).

## Non-goals

- HTTP/streaming details — owned by `openai-llm` (Spec 1).
- Tool registration, tool execution, or dispatch translation — owned by Specs 3–6.
- Slash command handling, memory injection, skills loading — those plugins subscribe to the events the driver emits; the driver does not know about them.
- Persistence of conversation state across process restarts. The driver keeps in-memory transcripts only.
- Backwards compatibility with `claude-driver`. The two drivers coexist; this plugin is structurally similar but covers a wider surface because Claude CLI was a closed black box and the LLM call is not.

## Manifest

```ts
{
  name: "llm-driver",
  apiVersion: "3.0.0",
  driver: true,
  permissions: { tier: "unscoped" },
  services: {
    consumes: [
      "llm-events:vocabulary",
      "claude-tui:channel",          // or its successor
      "llm:complete",                // required
      "tools:registry",              // optional — A-tier omits
      "tool-dispatch:strategy",      // optional — A-tier omits
    ],
    provides: ["driver:run-conversation"],
  },
}
```

`tier: "unscoped"` matches `claude-driver`. The driver orchestrates everything and crosses every boundary; lower tiers cannot express what it needs.

`consumes` lists service names. Required vs. optional is enforced inside `setup()`; missing optional services are detected via `ctx.tryUseService` (or equivalent) and the loop adapts.

## Conversation state ownership

The driver maintains two distinct state surfaces. Mixing them is the most common bug class this spec is trying to prevent.

### Interactive loop state (driver-private, mutable)

Held in `start()` as local variables. One per running driver instance.

- `messages: ChatMessage[]` — the running transcript.
- `systemPrompt: string` — the active system prompt. Mutable across turns (slash commands, memory plugins may rewrite it).
- `model: string` — current model selection. Defaulted from configuration; may be overridden mid-session by slash commands.
- `currentTurn: { id: string; controller: AbortController } | null` — non-null while a top-level turn is running.

Cleared by `conversation:cleared` subscribers that emit a request — the driver's own subscriber resets `messages` to `[]` and re-emits `conversation:cleared` for downstream listeners (status items, etc.) only after state is actually cleared. (See Open questions on whether the clear is request/response or fire-and-forget.)

### `runConversation` state (caller-owned, immutable input → returned output)

`runConversation` does **not** mutate the driver's interactive state and does **not** read it. It accepts a `messages` array as input and returns a new `messages` array as output. This is the contract that lets agents recurse without colliding with the parent turn's transcript.

The interactive loop in `start()` calls `runConversation` with its own `messages`, then **reassigns** its local `messages` variable to the returned `output.messages` for the next iteration. There is no shared-mutable-array trickery.

## Top-level interactive loop (`start()`)

Pseudocode. Event emissions and mutation points are called out explicitly.

```
emit("session:start")
messages := []
systemPrompt := config.defaultSystemPrompt
model := config.defaultModel

try {
  loop forever {
    line := await ui.readInput()
    if line is empty-sentinel: break

    // Give subscribers a chance to short-circuit (slash commands, etc.).
    inputEvent := { text: line }
    handled := false
    onceSubscriber("input:handled", () => { handled = true })
    await emit("input:submit", inputEvent)
    if handled: continue   // subscriber owned the input; skip default dispatch

    userMsg := { role: "user", content: line }
    messages.push(userMsg)
    await emit("conversation:user-message", { message: userMsg })

    turnId := newId()
    controller := new AbortController()
    currentTurn := { id: turnId, controller }
    ui.setBusy(true, pickBusyMessage())
    await emit("turn:start", { turnId, trigger: "user" })

    try {
      result := await runConversation({
        systemPrompt,
        messages,
        model,
        signal: controller.signal,
        // no parentTurnId — this is a top-level turn
        // no toolFilter — full registry view (or none, if tools registry absent)
      })
      messages := result.messages   // includes the assistant's reply(s) and any tool messages
      await emit("conversation:assistant-message", { message: result.finalMessage })
      await emit("turn:end", { turnId, reason: "complete" })
    } catch (err if err is AbortError) {
      await emit("turn:end", { turnId, reason: "cancelled" })
    } catch (err) {
      await emit("turn:error", { turnId, message: err.message, cause: err })
      await emit("turn:end", { turnId, reason: "error" })
      // recoverable — keep messages as they were before runConversation;
      // see Error handling below for the exact rollback rule
    } finally {
      currentTurn := null
      ui.setBusy(false)
    }
  }
} finally {
  await emit("session:end")
}
```

Subscribers:

- `turn:cancel` → if payload `turnId` matches `currentTurn.id` (or omitted), call `currentTurn.controller.abort()`. The abort propagates through every `runConversation` (top-level and nested) sharing that signal.
- `conversation:cleared` requests → the driver subscribes and resets `messages := []`. (Subscribers requesting the clear must not mutate `messages` themselves.)

## `runConversation` — the reusable inner loop

This is the only entry point exposed via `driver:run-conversation`. It is also what `start()` calls internally; there is exactly one implementation.

### Signature

Per Spec 0:

```ts
runConversation(input: RunConversationInput): Promise<RunConversationOutput>
```

### Pseudocode

```
function runConversation({ systemPrompt, messages, model, toolFilter, parentTurnId, signal }):
  // Establish a turn if not already established by the caller.
  // The interactive loop emits turn:start itself. Other callers (agents)
  // emit turn:start here with parentTurnId set.
  ownsTurn := parentTurnId !== undefined OR called-via-service
  turnId := ownsTurn ? newId() : (caller's turnId, threaded via context)

  if ownsTurn:
    await emit("turn:start", { turnId, trigger: "agent", parentTurnId })

  // Resolve optional services once per call.
  registry := tryUseService("tools:registry")           // may be undefined (A-tier)
  strategy := tryUseService("tool-dispatch:strategy")   // may be undefined (A-tier)

  // Working transcript — caller's messages are NOT mutated.
  workingMessages := [...messages]

  try {
    loop {
      // Build available tools view (filtered if requested).
      availableTools := registry ? registry.list(toolFilter) : []

      // Strategy contributes tools schema and/or system prompt augmentation.
      // If no strategy, this is a no-op single-shot path.
      strategyAdditions := strategy
        ? strategy.prepareRequest({ availableTools })
        : { tools: undefined, systemPromptAppend: undefined }

      request := {
        model: model ?? config.defaultModel,
        systemPrompt: appendIfPresent(systemPrompt, strategyAdditions.systemPromptAppend),
        messages: workingMessages,
        tools: strategyAdditions.tools,
        // temperature/maxTokens/etc. fall through from config
      }

      // Mutable hook — memory injection, system-prompt rewriting, model override.
      // Subscribers mutate request in place.
      await emit("llm:before-call", { request })

      // Immutable snapshot for observability.
      await emit("llm:request", { request: deepFreeze(structuredClone(request)) })

      // Stream the response. Forward stream events as their public counterparts.
      finalResponse := null
      try {
        for await (ev of llmComplete.complete(request, { signal })):
          switch ev.type:
            case "token":     await emit("llm:token", { delta: ev.delta })
            case "tool-call": await emit("llm:tool-call", { toolCall: ev.toolCall })
            case "done":
              finalResponse := ev.response
              await emit("llm:done", { response: ev.response })
            case "error":
              await emit("llm:error", { message: ev.message, cause: ev.cause })
              throw new LLMError(ev.message, ev.cause)
      catch AbortError:
        // signal fired — re-throw so caller's catch sees AbortError
        throw

      if finalResponse is null:
        throw new LLMError("stream ended without 'done' event")

      // Append the assistant message produced by this LLM call.
      assistantMsg := {
        role: "assistant",
        content: finalResponse.content,
        toolCalls: finalResponse.toolCalls,
      }
      workingMessages.push(assistantMsg)

      // No strategy or no registry → A-tier path: end turn after one call.
      if !strategy or !registry:
        break

      // Strategy decides whether to keep looping.
      appended := await strategy.handleResponse({
        response: finalResponse,
        registry,
        signal,
        emit: ctx.emit,
      })

      if appended.length === 0:
        break    // strategy says terminal

      workingMessages.push(...appended)
      // loop: another LLM call with the appended (tool result) messages
    }

    finalMessage := lastAssistantMessage(workingMessages)
    output := {
      finalMessage,
      messages: workingMessages,
      usage: aggregatedUsage,    // summed across all llm:done events in this call
    }

    if ownsTurn:
      await emit("turn:end", { turnId, reason: "complete" })

    return output

  catch (err):
    if ownsTurn:
      reason := isAbort(err) ? "cancelled" : "error"
      if reason === "error":
        await emit("turn:error", { turnId, message: err.message, cause: err })
      await emit("turn:end", { turnId, reason })
    throw    // always propagate; the interactive loop or agent caller decides recovery
```

### Mutation points (called out)

1. `llm:before-call` — subscribers may mutate `request` (system prompt, model, messages, temperature). This is the only sanctioned mutation.
2. `tool:before-execute` — emitted from inside the tools registry's `invoke`, not the driver. Mentioned here for completeness of the loop story.
3. Strategy `handleResponse` — produces appended messages, does not mutate inputs.

Everywhere else, payloads are treated as immutable. `llm:request` is a deep-frozen snapshot precisely so observers can't accidentally edit what `llm:before-call` subscribers already settled.

## Graceful degradation (A-tier)

A-tier harness has only `llm-events`, `openai-llm`, `llm-driver`, and the TUI. No `tools:registry`, no `tool-dispatch:strategy`. The loop must work without errors.

Behavior with neither service present:

- `request.tools` is `undefined`. `request.systemPrompt` is unmodified.
- After the single `llm:complete` call, the driver appends the assistant message and breaks out of the loop (the `if !strategy or !registry: break` branch).
- No `tool:*` events fire.
- `runConversation` returns one new assistant message in `messages`.

If only one of the two services is present (degenerate but possible during phased rollout), the driver still takes the A-tier path. Both must be present to enable the multi-step strategy loop. This keeps the contract simple: tools and dispatch are a matched pair.

## Concurrency model

### Top-level turns

Only one top-level turn runs at a time. `start()` awaits each `runConversation` before reading the next input line. There is no input queue; the TUI blocks on `readInput()` while the turn is in flight. If the user submits via a non-blocking input path (future), the driver rejects with a `turn:already-running` style error — out of scope for this spec.

### Nested turns (agents)

When `llm-agents` calls `driver:run-conversation` from inside a tool handler, that handler is being awaited inside the parent turn's strategy `handleResponse`. The parent turn does **not** end until the child returns. The call graph is:

```
parent turn:start
  parent runConversation
    parent llm:complete (returns tool_calls)
    parent strategy.handleResponse
      tools:registry.invoke("dispatch_agent", …)
        agents plugin calls driver:run-conversation
          child turn:start (parentTurnId = parent.turnId)
          child runConversation
            child llm:complete …
          child turn:end
        return child final message as tool result
    parent strategy returns appended tool message
    parent llm:complete (next iteration) …
  parent turn:end
```

This linkage is observable via `parentTurnId` on `turn:start`. Telemetry plugins can build a tree.

### Signal propagation

Each `runConversation` accepts an optional `signal`. If absent, the driver creates its own `AbortController` for that call. The interactive loop passes its `currentTurn.controller.signal` into the top-level `runConversation`, so `turn:cancel` aborts the entire tree.

Agents that want cancellation independent from the parent (e.g., a timeout on a single agent dispatch) pass their own `AbortSignal`. The agents plugin is responsible for chaining: `AbortSignal.any([parent, ownTimeout])` if both should cancel the child.

## Cancellation semantics

`turn:cancel` is the only public cancel surface.

Subscriber behavior:

- Payload `{ turnId }` provided → cancel iff it matches `currentTurn.id`. Mismatch is a no-op (the targeted turn already finished).
- Payload `{}` (no `turnId`) → cancel current top-level turn.
- No way to cancel a specific nested child from outside; agents can pass their own signal if they need granular cancel.

Effects:

- `currentTurn.controller.abort()` is called.
- The signal propagates to `llm:complete` (must honor `opts.signal` — Spec 0 contract).
- The signal propagates to `tools:registry.invoke` via the strategy (Spec 0 `ToolExecutionContext.signal`).
- All in-flight async iteration sees the abort; the driver re-throws as `AbortError`.
- `turn:end` fires with `reason: "cancelled"`.
- The interactive loop's `messages` is left at its **pre-turn** value. See Error handling for the rollback rule.

## Error handling

Two classes:

### Recoverable

Any `LLMError` (including provider HTTP errors, malformed responses, tool execution errors that bubble up through the strategy). The driver:

1. Emits `llm:error` (already done at the source).
2. Emits `turn:error` with `{ turnId, message, cause }`.
3. Emits `turn:end` with `reason: "error"`.
4. Re-throws to the caller (interactive `start()` or agents).
5. The interactive loop catches, logs to the TUI, and **rolls back** `messages` to the pre-turn value. Rationale: a half-applied transcript (user message present, no assistant reply) confuses subsequent turns and the LLM's context. The user can resubmit.

This rollback is the reason `messages := result.messages` only happens on the success path. The `try` block keeps a reference to the pre-turn `messages` snapshot.

### Fatal

Anything that escapes `runConversation` that is not an `LLMError` or `AbortError` (e.g., service registry corruption, programming error in a subscriber). The driver:

1. Emits `session:error` from `start()`.
2. Tears down the loop (`finally` block emits `session:end`).
3. The harness host decides what to do (most likely process exit).

Subscriber errors are caught by the event bus per its existing contract; they do not bubble into the driver's loop. (Spec 0 assumes this; if not, a separate change to the bus is needed and Spec 0 must be updated first per the propagation rule.)

## Service: `driver:run-conversation`

Provided as `DriverService` from Spec 0:

```ts
interface DriverService {
  runConversation(input: RunConversationInput): Promise<RunConversationOutput>;
}
```

The provided value is a thin wrapper over the same internal `runConversation` function used by `start()`. The wrapper:

- Generates `turnId` and emits `turn:start` / `turn:end` (because external callers don't own a turn yet).
- Sets `trigger: "agent"` on `turn:start` (top-level interactive turns set `"user"`).
- Honors `parentTurnId` if supplied.
- Does not touch the driver's interactive `messages`/`systemPrompt`/`model`. Caller-supplied values win.

## File layout

Mirrors `claude-driver` at one greater level of detail.

```
plugins/llm-driver/
  index.ts                  // KaizenPlugin export, setup/start, service registration
  loop.ts                   // runConversation implementation
  state.ts                  // interactive-loop state helpers (rollback snapshots, currentTurn)
  cancel.ts                 // turn:cancel subscription wiring
  ids.ts                    // turn-id generator
  busy-messages.ts          // reused pattern from claude-driver
  public.d.ts               // re-exports DriverService from llm-events shared types
  index.test.ts
  loop.test.ts
  cancel.test.ts
```

`loop.ts` is the unit-testable core. `index.ts` is the I/O shell.

## Test plan

Unit tests, all with mocked services (no real HTTP, no real TUI).

### `loop.test.ts`

1. **A-tier single-shot.** No registry, no strategy. Mock `llm:complete` to emit `token` × 3 + `done`. Assert: one `llm:before-call`, one `llm:request`, three `llm:token`, one `llm:done`, no `tool:*`, returned `messages` has exactly one new assistant message.
2. **Native dispatch loop.** Strategy returns one tool message after first response, then empty after second. Assert two LLM calls, transcript has `[…input, assistant1, tool1, assistant2]`.
3. **`llm:before-call` mutation.** Subscriber rewrites `systemPrompt` and `model`. Assert the `llm:complete` mock receives the mutated request, and the `llm:request` snapshot reflects the post-mutation state.
4. **`llm:request` immutability.** Attempt to mutate the snapshot from a subscriber; assert the mutation is rejected (frozen object).
5. **LLM error.** Mock emits `error`. Assert `llm:error` + `turn:error` + `turn:end{reason:"error"}` and the function throws. No partial assistant message in returned transcript (because the function threw, no value was returned).
6. **Strategy error.** Strategy throws synchronously inside `handleResponse`. Same expectations as case 5.
7. **Caller-input not mutated.** Pass a frozen `messages` array; assert `runConversation` doesn't try to mutate it (works only because we copy).

### `cancel.test.ts`

8. **Top-level cancel.** Start a run, fire `turn:cancel`. Assert the mock `llm:complete`'s signal sees `aborted=true`, `turn:end{reason:"cancelled"}` fires, function rejects with `AbortError`.
9. **Targeted `turnId`.** Two sequential turns. Cancel-by-id for an already-ended turn is a no-op; cancel for the running one works.
10. **Nested cancel via parent signal.** Parent `runConversation` with shared signal; child `runConversation` started inside parent's strategy. Abort parent → both end with `cancelled`.
11. **Nested independent signal.** Child supplied its own signal not chained to parent. Abort child's signal → child ends `cancelled`, parent continues.

### `index.test.ts`

12. **Interactive loop happy path.** Mock TUI emits two input lines then empty. Assert `session:start`, two complete `turn:start`/`turn:end` cycles, `session:end`.
13. **`input:handled` short-circuit.** Subscriber claims the input. Assert no `turn:start`, no `runConversation` invocation, the loop reads the next line.
14. **Recoverable error rollback.** First turn errors (LLM mock throws). Assert `messages` after the failed turn equals `messages` before it (no orphan user message). Second turn proceeds normally.
15. **`conversation:cleared`.** External event clears state; assert `messages` is `[]` afterward and the next turn starts from empty.
16. **Service registration.** `driver:run-conversation` is provided; calling it externally produces `turn:start{trigger:"agent",parentTurnId:?}` even when no interactive loop is running.

## Acceptance criteria

- `llm-driver` builds against the contracts in Spec 0 with no extensions to those contracts.
- A-tier harness (`llm-events` + `openai-llm` + `llm-driver` + TUI) supports a full chat session with no tools and no dispatch strategy registered.
- `turn:cancel` aborts the current turn within one event-loop tick of the abort being propagated through `llm:complete`.
- `driver:run-conversation` is callable from a separately-loaded plugin and produces correctly linked `parentTurnId` events.
- All tests in the plan pass; coverage of `loop.ts` is ≥90% line.
- Marketplace `entries` updated for `llm-driver`.

## Open questions for downstream

1. **`conversation:cleared` semantics.** Is it a request (driver subscribes and resets) or a notification (someone else mutated state and is announcing it)? This spec assumes request-style with the driver as the authoritative state owner. If memory/agents plugins want to push state changes, Spec 0 may need a `conversation:set-messages` mutation event — propagation rule applies.
2. **Multiple dispatch strategies.** Spec 0 phrases `tool-dispatch:strategy` as a single service. If the harness ever wants to mix native and code-mode in the same run (e.g., tools registered with a `prefer: "codemode"` tag), the strategy contract needs a selector. Out of scope here; raise in Specs 4/5 if it matters.
3. **Usage aggregation.** This spec sums `prompt/completionTokens` across all `llm:done` events in a `runConversation`. Provider plugins may report differently (cached tokens, reasoning tokens). Spec 1 (`openai-llm`) should pin the exact `usage` shape; if it grows fields, Spec 0 must be updated first.
4. **Input gate timing.** The `input:handled` short-circuit relies on the subscriber setting a flag synchronously during `emit("input:submit")`. If the bus is fully async/serialized, the driver may need to await all subscribers before checking. Confirm bus semantics; if async, switch to a request/response service `input:dispatch` instead.
5. **Driver liveness during agent-only sessions.** If an external host calls `driver:run-conversation` but never calls `start()`, no `session:start`/`session:end` fires. Should `setup()` emit `session:start` instead, with `start()` only handling the TUI? Likely yes; defer to first integration.
6. **TUI service rename.** Spec 0 hedges with "claude-tui:channel (or its successor)." If the TUI is renamed before `llm-driver` ships, this spec's `consumes` list updates accordingly; no other change.
