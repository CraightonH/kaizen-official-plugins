# llm-codemode Tool Pivot — Design

**Status:** Draft
**Date:** 2026-05-07
**Supersedes (in part):** `2026-04-30-llm-codemode-dispatch-design.md`, `2026-05-04-llm-codemode-api-surface-design.md`

## Summary

Replace the current `llm-codemode-dispatch` plugin — which avoids the OpenAI tool-calling protocol and parses fenced TypeScript out of assistant prose — with a new `llm-codemode` plugin that registers a single tool named `execute_typescript` via the standard tool registry. The Cloudflare "code mode" thesis (LLMs compose better in code than in chained tool calls) is preserved; only the wire envelope changes. As a side effect, fix `docs/TODO.md` item #2 — LLM confusion on recall between user messages and tool results — by routing every machine action through OpenAI's `tool_calls` / `tool` role mechanism, with no fake user-role messages.

This pivot also introduces a new `tool_call` transcript kind in `llm-tui`, plus driver-level lifecycle events around tool dispatch, so the user sees tool calls as their own first-class blocks distinct from Thoughts.

## Motivation

### Two problems with the current implementation

**Problem 1 — TODO #2: LLM cannot distinguish tool results from user messages on recall.** The current `llm-codemode-dispatch` plugin returns sandbox results as a synthesized `user` role message prefixed with the literal string `[code execution result]\n`. The system prompt instructs the LLM to read it as runtime output, but on subsequent turns — especially after compaction or with weaker models — the LLM treats it as a user request and gets confused.

**Problem 2: tool calls render as Thoughts in the TUI.** The `llm-tui` plugin renders accumulated reasoning deltas as collapsed Thoughts blocks. Tool calls and their results pass through as part of assistant output, with no visual distinction. Users cannot tell at a glance what the LLM did versus what it thought about doing.

### Root cause is shared

Both problems stem from a single architectural choice: the codemode dispatch plugin sidesteps OpenAI's `tool_calls` / `tool` role mechanism and uses prose + system-prompt conventions instead. This is a deviation from the Cloudflare "code mode" design that the plugin was modeled after — Cloudflare's blog explicitly describes "just one tool, which simply executes some TypeScript code," dispatched through normal tool-calling. The plugin's current shape was a defensive choice for the case where local LLMs cannot reliably emit valid `tool_calls` JSON for any tool, but that case is not the target of the harness going forward.

### Decision: codemode targets tool-calling-capable models only

The user has confirmed that the codemode plugin's target audience is models that support OpenAI tool-calling. This eliminates the original justification for the prose-fence approach and unlocks the canonical design.

## Design

### Architecture

**One concept, one path.** Every machine action — whether a one-shot `read_file` or a code-mode dispatch — flows through OpenAI's `tool_calls` mechanism. There is no second dispatch path, no per-strategy branching, no "is this code-mode or native?" decision in the driver. The driver routes each entry in the LLM's `tool_calls` response to the registered handler for that tool.

**Codemode is a tool, not a strategy.** The new `llm-codemode` plugin registers exactly one tool with the standard tool registry:

```
name: execute_typescript
description: <rendered .d.ts of kaizen.tools namespace + usage example>
parameters: { code: string }
handler: (args) => runInSandbox(args.code, registry, signal, config)
```

The plugin no longer provides a `tool-dispatch:strategy` service. It does not modify `prepareRequest`. It does not extract code from prose. It is a normal tool implementer that happens to use a Worker sandbox in its handler.

**API teaching moves to the tool description.** The typed `kaizen.tools` `.d.ts` block currently rendered into the system prompt by `prepareRequest` moves into the `description` field of the `execute_typescript` tool. This puts the API teaching exactly where the LLM expects to find it for that tool, leveraging the model's tool-calling training. If real tool-description sizes exceed some provider's caps, fall back to a short description plus system-prompt append carrying the full `.d.ts` — decision deferred until measured.

**The architecture must allow coexistence (mode B).** The user's personal usage will register only `execute_typescript` as the sole tool (mode A: codemode-only). However, the architecture must not preclude registering `execute_typescript` alongside individually-registered native tools. Models will then decide per turn whether to invoke a native tool directly or to compose via `execute_typescript`. This requires no special support — `execute_typescript` is just another registration in a flat tool registry — but it must not be retrofitted away by future code that assumes a single dispatch shape.

### TUI rendering

**One new transcript kind.** Extend `TranscriptKind` in `plugins/llm-tui/state/store.ts` with a `tool_call` value:

```typescript
export type TranscriptKind = "output" | "notice" | "user" | "thoughts" | "tool_call";
```

Every tool — codemode or otherwise — produces one `tool_call` entry per invocation. No subtypes; rendering varies by tool name, not by transcript kind.

**Mutable tool_call entries; everything else stays immutable.** Tool calls are inherently stateful — they exist before they have a result. The store gains:

```typescript
appendToolCall(id: string, name: string, argsPreview: string): void;
updateToolCall(id: string, patch: {
  status?: "running" | "done" | "error";
  result?: string;
  stdoutDelta?: string;
}): void;
```

Implementation replaces the entry rather than mutating in place, preserving the snapshot-identity invariant. Other transcript kinds remain immutable.

**Driver-level lifecycle events.** New events in the `llm-events` vocab, emitted by the driver around the handler invocation:

- `tool:start { id, name, args, turnId, sessionId }` → emitted before the handler runs; TUI appends a `tool_call` entry, status `running`.
- `tool:progress { id, delta, turnId, sessionId }` → optional, opt-in by the handler; TUI appends to the live stdout buffer of the matching entry. The codemode plugin emits these from the sandbox host on stdout messages from the worker.
- `tool:done { id, result, turnId, sessionId }` → emitted after the handler resolves; TUI transitions the entry to `done`, attaches result.
- `tool:error { id, error, turnId, sessionId }` → emitted if the handler throws; TUI transitions to `error`, attaches message.

The existing `codemode:*` event family becomes internal sandbox telemetry; the TUI no longer subscribes to it. (The events may stay or be folded into `tool:progress` — implementation choice during step 3 of the migration.)

**Default renderer (collapsed):**

```
▸ read_file          /etc/hosts                              ✓ 1.2 KB
▸ execute_typescript exec 14 lines                           ⠋ running…
▸ bash               curl -sf https://example.com            ✗ exit 22
```

One line: arrow + tool name + truncated arg preview (right-padded, monospace) + status glyph + result summary. Spinner glyph while running; ✓/✗ on terminal state.

**Tool-renderer registry, contributed by plugins.** New TUI service: `llm-tui:tool-renderer`. Plugins register a renderer keyed by tool name:

```typescript
interface TuiToolRenderer {
  toolName: string;
  collapsedSummary: (args: unknown) => string;
  expandedView: (args: unknown, result: string | undefined, status: "running" | "done" | "error") => ReactNode;
}

interface TuiToolRendererService {
  register(renderer: TuiToolRenderer): () => void;
}
```

The `llm-codemode` plugin ships its own renderer (syntax-highlighted code, stdout pane, return-value line). Other tool-implementer plugins may ship richer renderers; missing ones fall back to a generic `JSON.stringify` collapsed/expanded view shipped by `llm-tui` itself.

**Expansion gesture, generalized history view.** Today `Ctrl+R` toggles the most-recent Thoughts block, and `/history` modal-views Thoughts only. Extend `/history` to a generalized audit view that lets the user cycle through `tool_call` *and* `thoughts` entries in chronological order, with expand/collapse on each. This becomes the "what did the LLM actually do?" surface, which is arguably more useful than the current Thoughts-only view. Implementation extends the existing `historyView` state in the store; the existing `Ctrl+R` chord remains scoped to the most-recent Thoughts block for backward compatibility.

**Per-turn render order:**

```
> user input
  Thoughts (collapsed)              ← from llm:reasoning + llm:done finalize
▸ tool_call: execute_typescript     ← from tool:start (running, live stdout)
  …(live stdout under the running entry, replaced by result on done)
▸ tool_call: ...                    ← if multiple tool_calls in one turn, sequential
  assistant prose output            ← post-tool reasoning the LLM emits
> next user input
```

Thoughts and tool_calls are clearly distinct visual primitives. Order reflects actual sequence.

**Spinner coexistence.** The global `SpinnerLine` ("the turn isn't done") and per-row spinners on running `tool_call` entries ("this specific call is mid-flight") coexist. Same animation, different scope.

### History and replay framing

**Driver owns the canonical conversation in OpenAI shape.** After the pivot, the conversation array stored by the driver and replayed verbatim on each subsequent request is exactly the OpenAI Chat Completion shape:

```
{ role: "system",    content: "..." }
{ role: "user",      content: "..." }
{ role: "assistant", content: "...", tool_calls: [{ id, function: { name, arguments } }, ...] }
{ role: "tool",      tool_call_id: "...", content: "<serialized result>" }
{ role: "tool",      tool_call_id: "...", content: "<serialized result>" }
{ role: "assistant", content: "..." }
{ role: "user",      content: "..." }
```

There is no translation layer between what the LLM produced and what we send back. No prefix conventions baked into prose. The model sees its own past `tool_calls` and the matching `tool` role results — exactly the shape it is trained to recognize. **TODO #2 dissolves at this layer**; there is nothing for the LLM to mistake for a user turn.

**Store is a projection, not the source of truth.** The driver holds the OpenAI-shape conversation; the TUI store holds renderable transcript lines. The store never invents content; it only re-shapes:

- One `assistant` message → 0..1 Thoughts entries (from streamed `reasoning`) + 0..N `tool_call` entries (from `tool_calls`) + 0..1 `output` entries (from `content`).
- One `tool` message → fills in `result` on the matching `tool_call` entry (same `tool_call_id`).
- One `user` message → one `user` entry.

**Tool result serialization.** The `tool` message's `content` is a string (per OpenAI). For `execute_typescript`, that string is the structured run result — `{ exit, stdout, stdoutTruncated, returnValue, error? }` formatted as a readable block via the carried-over `serialize.ts` formatter. The `[code execution result]\n` prefix disappears; the role label `tool` carries that signal now. For other tools, the handler's return value is stringified the same way it would be for any tool.

**Errors are tool results, not exceptions.** A sandbox transpile error, a Worker crash, a timeout, or a tool's thrown exception all serialize into a `tool` role message with the error encoded in `content`. The conversation stays well-formed; the LLM sees the failure and can react. The only thing that escapes the dispatch path as an exception is `AbortError` on cancellation, same as today.

**Cancellation injects a synthetic tool result.** If the user hits Ctrl+C mid-tool-execution, the driver must close out the `tool_call_id` with a `tool` message — otherwise the conversation has a dangling `tool_calls` entry and the next request to the LLM is malformed. Inject `{ role: "tool", tool_call_id, content: "<cancelled by user>" }` and stop the turn. The model sees on next prompt that the call was cancelled and can adjust.

**Truncation pairs assistant + tool results atomically.** Whatever context-window management lives in the driver today, it now must treat `(assistant_message_with_tool_calls + all matching tool messages)` as one indivisible unit. Dropping the assistant turn without its tool results is fine; dropping a tool result without its assistant turn creates a dangling `tool_call_id` that some providers reject and all models find confusing.

**`/clear` semantics unchanged.** The driver's conversation array clears; the store's transcript clears along with it (it is a projection). No new behavior.

## Migration plan

The pivot ships in five independently-shippable steps. Each step is reversible until step 5.

### Step 1 — TUI changes (no codemode dependency)

Add the `tool_call` transcript kind, store methods (`appendToolCall`, `updateToolCall`), event subscriptions for `tool:start | tool:progress | tool:done | tool:error`, the default renderer, and the `llm-tui:tool-renderer` registry service. Generalize `/history` to include `tool_call` entries.

These improvements apply to *any* tool calls (native or future) and are useful even if the codemode pivot were never shipped. Lowest-risk first step. Fully tested against the existing native tool-call path before subsequent steps land.

### Step 2 — Driver lifecycle events

In `llm-driver`, wherever the dispatcher invokes a registered handler for a `tool_calls` entry, wrap with `tool:start` before and `tool:done` / `tool:error` after. Progress emission (`tool:progress`) is opt-in by the handler — codemode emits, trivial tools do not.

Update truncation logic to treat `(assistant_message_with_tool_calls + matching tool messages)` as atomic units.

### Step 3 — New `llm-codemode` plugin

Create `plugins/llm-codemode/` as a fresh plugin. Copy from `plugins/llm-codemode-dispatch/`:

- `wrapper.ts` — unchanged
- `sandbox-host.ts` — unchanged
- `sandbox-entry.ts` — unchanged
- `serialize.ts` — modified: drop the `[code execution result]\n` prefix and the prose envelope; output the structured run result as a readable string suitable for a `tool` message's `content`.
- `dts-render.ts` — unchanged in mechanism; consumed by the plugin's tool-registration path instead of `prepareRequest`.
- `config.ts` — copy with config path updated to `~/.kaizen/plugins/llm-codemode/config.json` (and the env override renamed to `KAIZEN_LLM_CODEMODE_CONFIG`).

Since the old plugin is retired in step 5, sharing via an extracted package would create a single-consumer dependency. Copy is the correct path.

The new plugin's `index.ts`:

- Loads config.
- Renders the kaizen.tools `.d.ts` from the live tool registry at registration time (or per call, if the registry can change mid-session — implementation detail).
- Registers `execute_typescript` with the standard tool registry, with the rendered description, the `{ code: string }` parameter schema, and a handler that calls `runInSandbox`.
- Ships a TUI tool renderer for `execute_typescript` via `llm-tui:tool-renderer` (syntax-highlighted code, stdout pane, return value).

Does **not** provide a `tool-dispatch:strategy` service. Does **not** modify `prepareRequest`. Does **not** parse code from prose.

### Step 4 — Smoke test against target models

With the new plugin loaded, verify on each target local model (LM Studio, Ollama, whichever models the user actually uses) that:

- The model emits a valid `tool_calls` array referencing `execute_typescript`.
- The `arguments.code` field round-trips intact — including code that contains backticks, template literals with `${...}` interpolation, JSON-quoted strings, and multi-line strings. (Backticks survive JSON encoding fine, but template-literal-followed-by-JSON-escape has tripped some providers' serializers historically. If broken, fall back to base64-encoding the code argument.)
- Multi-step turns (call → result → next call) work over multiple iterations.
- Cancellation mid-execution leaves the conversation well-formed (no dangling `tool_call_id`).

This is the empirical step. If any target model fails it, that is a real finding — either fix prompting in the tool description, or downgrade that model from the supported list.

### Step 5 — Retire the old plugin and update specs

This is the cutover. Bundle into one change to keep the harness consistent at every commit:

- Update `harnesses/openai-compatible.json` to remove `llm-codemode-dispatch` from the plugin list and add `llm-codemode` in its place. **The openai-compatible harness migrates to the new plugin as part of this step.** Without this update, retiring the old plugin breaks the harness for existing users.
- Remove `llm-codemode-dispatch` from `~/.kaizen/marketplaces/official/repo/` (the local marketplace mirror) and from `plugins/`.
- Delete the `tool-dispatch:strategy` service contract from Spec 0 (no remaining consumers after retirement).
- Rewrite Spec 6 (`2026-04-30-llm-codemode-dispatch-design.md`) — or supersede it with this document as the new authoritative spec for codemode behavior.
- Update the architecture memory at `~/.claude/projects/-Users-chancock-git-kaizen-official-plugins/memory/openai_compatible_harness_arch.md` — specifically the "Code-mode dispatch is the default tool-dispatch strategy" decision is no longer accurate. The replacement framing: "Codemode is a tool, registered via the standard registry. Native tool-calling is the only dispatch protocol."
- Move this spec from `docs/superpowers/specs/` to `docs/superpowers/archive/specs/` once shipped.

## Risks and unknowns

- **DTS-as-tool-description size.** OpenAI's docs do not formally cap description length, but some providers (Together, Groq, certain LM Studio configs) reject long descriptions or truncate them silently. Worst case: render a *short* description in the tool spec and put the full `.d.ts` in a system-prompt append. Same teaching, different split. Decide after measuring real `.d.ts` sizes against actual registered tool counts. (Mitigation in step 3 if encountered; otherwise no action.)
- **Backtick / template literal escaping in tool arguments.** Mitigated in step 4 testing. If broken, base64-encode the code argument. Ugly but bulletproof.
- **No coexistence between old and new plugins in the same session.** If both are loaded, the model sees a system-prompt-taught API surface (from old) *and* a tool registration (from new), and gets a confusing dual instruction surface. The harness manifest must pick one. Step 5's harness update enforces this; until step 5 lands, the new plugin is opt-in via custom harness manifests only. Document this in the new plugin's README.
- **TUI changes shipping ahead of plugin pivot.** Step 1 lands `tool_call` rendering before any tool actually emits the new lifecycle events. Empty until step 2 wires the driver. This is intentional — step 1 is independently testable against synthetic events.

## Out of scope

- The `claude-driver` and `claude-tui` plugins. The claude-wrapper harness is unchanged.
- The `llm-driver`'s turn loop, conversation state, and turn-level lifecycle events (`turn:start`, `turn:end`, `turn:cancel`). Only the per-tool-call seam changes.
- The skills, agents, slash, MCP-bridge, status-bar, and theme plugins. All orthogonal to this pivot.
- Any change to native tool-call dispatch other than the addition of lifecycle events. Native tools work exactly as they do today, just with new visibility.

## What this kills

- `[code execution result]\n` prefix and the system-prompt instruction that explains it.
- Fake `user` role messages carrying tool results.
- Any "is this a tool result or a user message?" disambiguation at the LLM seam.
- The mental gap between "what the user sees" and "what the LLM sees" — they are the same conversation, rendered differently.
- The `tool-dispatch:strategy` service contract.
- `extractor.ts` (mdast fence parsing) and `handle-response.ts` (prose-extraction lifecycle) from the codemode codebase.

## What this preserves

- The Cloudflare "code mode" thesis — composition in code beats composition in chained tool calls.
- The typed `kaizen.tools` API surface.
- The Worker sandbox, transpile lint, async-IIFE wrap, stdout cap, and abort-on-signal semantics.
- The microservice plugin discipline — `llm-codemode` is a self-contained plugin replaceable without touching any other.
- Native tool-call dispatch for individually-registered tools, which already works.
