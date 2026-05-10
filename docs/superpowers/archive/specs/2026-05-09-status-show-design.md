# `/status:show` Slash Command + Tool

**Date:** 2026-05-09
**Status:** Design

## Goal

Surface the current contents of the status bar on demand, both to the human (slash command) and to the LLM (tool peer), so the LLM can decide for itself whether the prompt is filling the context window and consider clearing.

## Principle

Show only numbers we already have from the provider/model APIs. No estimation, no tokenizer libraries, no per-component breakdowns. The status bar already reflects ground truth from `llm:done` `usage` and `llm:complete.listModels()`; this command exposes that same truth in expanded form.

## Architecture

Follows the slash↔tool counterpart pattern (Spec 2026-05-09-slash-command-tool-counterparts):

```
llm-status-items
├── state.ts (existing)        ← reducer; canonical StatusState
├── snapshot.ts (NEW)          ← buildSnapshot(state, costCents?, hasAnyRate) → StatusSnapshot
├── slash.ts   (NEW)           ← /status:show adapter; formats snapshot for ctx.print()
├── tool.ts    (NEW)           ← status:show tool adapter; returns StatusSnapshot as JSON
└── index.ts                   ← passes a getter for current state to both adapters
```

**Invariants:**

- Both adapters read from a `() => StatusSnapshot` closure provided by `index.ts`. Neither adapter touches `StatusState` directly.
- `buildSnapshot()` is pure and synchronous. It does not trigger `listModels()` — if `contextLength` is null in state, it is null in the snapshot.
- Output divergence is expected: slash formats a human-readable text block; tool returns the raw `StatusSnapshot` JSON.
- Tool name mirrors slash name verbatim: `status:show`.

## `StatusSnapshot` shape

```ts
interface StatusSnapshot {
  model: string | null;
  session: { id: string | null; alias: string | null };
  contextWindow: {
    lastPromptTokens: number;        // tokens reported on most recent llm:done
    contextLength: number | null;    // model ceiling, null if listModels unavailable
    pctUsed: number | null;          // lastPromptTokens / contextLength, null if ceiling null
  };
  sessionTotals: {
    promptTokens: number;            // cumulative across this session's calls
    completionTokens: number;
  };
  tokensPerSec: number | null;       // last completed turn; null until first measurement
  costCents: number | null;          // null when no rate table or model not priced
}
```

All fields read directly from `StatusState` (or `costCents` from the closure in `index.ts`). Nothing is estimated.

## Slash output

```
model:           gpt-4o-mini
session:         01HXYZ... (my-alias)
context window:  3,421 / 8,192  (41%)
session totals:  in=12,303  out=2,103
tok/s (last):    87.4
cost (est):      $0.0123
```

Lines for null fields are omitted. Numbers use locale-grouped thousands. Percentage rounds to nearest integer. `tokensPerSec` follows the bar's existing rule (`>=10` → integer, else 1 decimal). Cost line only appears when `costCents != null`.

## Tool definition

```ts
{
  name: "status:show",
  description: "Return current status-bar values: model, context-window usage, session token totals, throughput, and cost. All numbers are reported by the provider — no estimation. Useful for deciding whether to clear context.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
}
```

Returns `StatusSnapshot` directly. No args.

## Implementation notes

### `snapshot.ts`

```ts
export function buildSnapshot(
  state: StatusState,
  costCents: number | null,
): StatusSnapshot {
  const { contextLength, lastPromptTokens } = state;
  const pctUsed = contextLength && contextLength > 0
    ? lastPromptTokens / contextLength
    : null;
  return {
    model: state.model,
    session: { id: state.sessionId, alias: state.sessionAlias },
    contextWindow: { lastPromptTokens, contextLength, pctUsed },
    sessionTotals: {
      promptTokens: state.promptTokens,
      completionTokens: state.completionTokens,
    },
    tokensPerSec: state.tokensPerSec,
    costCents,
  };
}
```

Pure function, trivially unit-testable.

### `index.ts` wiring

`llm-status-items` currently consumes `llm-events:vocabulary` and `llm:complete`. It will additionally consume `slash:registry` and `tools:registry` softly, using the deferred-registration pattern (`harness:start`):

- Tier bumps from `unscoped` to keep `ctx.on` available — already `unscoped`, so no change.
- `services.consumes` adds `slash:registry` and `tools:registry`. (Soft via try/catch, same as `llm-session-manager` will after the counterpart refactor lands.)
- A single `getSnapshot = () => buildSnapshot(state, hasAnyRate ? costCents : null)` closure is passed to both `registerSlash()` and `registerTool()`.
- Cost is only reported when `hasAnyRate` is true; otherwise `costCents` is null in the snapshot regardless of `costCents` accumulator value.

### Cost reporting subtlety

`emitCost()` clears the cost-estimate bar item when `tokensToCents()` returns null (model not priced). The snapshot follows the same rule: if the active model isn't in the rate table on the most recent `llm:done`, `costCents` is null in the snapshot. Track this via a `costPriced: boolean` companion to `costCents` in `index.ts` (already implicit in the existing `costActive` flag — reuse it).

### What does *not* change

- `state.ts` reducer: untouched. Snapshot is a pure projection of existing fields.
- `context.ts` formatter: untouched.
- Status bar emission: unchanged.
- `cost.ts`: unchanged.

## Testing

- **`snapshot.test.ts`** (new): exhaustive cases for `buildSnapshot()` — null model, null ceiling, zero tokens, all fields populated, costCents null vs. set.
- **`slash.test.ts`** (new): formats expected text for representative snapshots (full, missing ceiling, no cost). Asserts null lines are omitted.
- **`tool.test.ts`** (new): tool handler returns the snapshot verbatim from the closure.
- **Parity test** in `index.test.ts`: register both adapters against fake registries on `harness:start`; invoke each; assert both produce a value derived from the same `StatusState`.
- Existing tests untouched.

## Out of scope

- Per-component breakdown (system prompt vs tools vs messages vs tool responses). Provider doesn't supply this; explicitly rejected.
- Tokenizer integration. Not needed.
- Auto-suggesting `/clear` when `pctUsed > 0.7`. The LLM can decide from the data; we don't second-guess.
- Surfacing tool/system-prompt counts even when they're not estimates. Adds noise; if a future use case appears, extend the snapshot then.

## Naming rationale

`/status:show` over `/status` because `llm-slash-commands` reserves bare names for the runtime and the user agreed the namespaced form is fine given help-text autocomplete handles discovery.

Tool name `status:show` mirrors slash verbatim per the counterpart pattern.
