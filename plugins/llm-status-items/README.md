# llm-status-items

Status-bar items for the OpenAI-compatible LLM session — model name, token counters, throughput, context-window fill, and (optionally) a running cost estimate.

## What it does

Subscribes to harness/turn/LLM/tool events and translates them into status-bar updates. Each item is a single `key`/`value` pair emitted on change; the TUI plugin owns rendering.

Items emitted:

| Key | Source | Value | Notes |
|-----|--------|-------|-------|
| `_model` | `llm:before-call` (or runtime-loaded fallback) | `gpt-4.1-mini` | Labelless; model name is self-describing. Falls back to the provider's loaded model id when the request omits `model`. |
| `_io` | `llm:done` | `<prompt> ↑ <completion> ↓` cumulative tokens | Labelless; ↑ = sent, ↓ = received. Reset to `0 ↑ 0 ↓` on `conversation:cleared`. |
| `tok/s` | `turn:end` | completion tokens / second for the last turn | `0` until first measurement; cleared on `conversation:cleared`. |
| `_ctx` | `llm:done` + provider metadata | `13.2k/32k [████░░░░░░] 41%` | Denominated against the *most recent* prompt size, not session totals. Hidden when ceiling unknown. |
| `cost-estimate` | `llm:done` | `$0.0123` | Only emitted when a rate table is present and the active model is in it. |
| `session` | `session:active-changed` / `session:renamed` | full session id, optionally `id (alias)` | Cleared when no session is active. |

Other behaviors:
- On `harness:start` the plugin renders zero-valued counters and the empty context bar so the status line is populated before any turn runs.
- The context-window ceiling is resolved lazily via `llm:complete.listModels()` and cached per model id; when the driver leaves `model` unset, the single runtime-loaded model (`loadedContextLength`) is used as both the ceiling and the displayed `model` value.
- All emissions are diffed — repeat events with unchanged values do not re-emit.
- `conversation:cleared` zeros tokens, throughput, cost, and the context bar; `_model` persists.

## Wiring

### Consumes

**VOCAB** — `events:vocabulary` (required).
Provides the event names and `ChatMessage` / `LLMRequest` / `LLMResponse` / `status:item-*` payload shapes the plugin subscribes to and emits.

Subscribed events:
- `harness:start`
- `llm:before-call`
- `llm:done`
- `turn:start`
- `turn:end`
- `tool:before-execute`
- `tool:result`
- `tool:error`
- `conversation:cleared`
- `session:active-changed`
- `session:renamed`

**Service** — `llm:complete` (required, used lazily).
Only `listModels()` is invoked, the first time a context ceiling is needed. The service is consumed at `setup` but resolved on demand so the producing plugin's setup order does not matter. Providers that don't implement `listModels` (or throw) are tolerated — the `_ctx` item is simply hidden.

**Service** — `slash:registry` (optional). When present at `harness:start`,
registers `/status:show`, which prints the current model, session, context
window, token totals, throughput, and cost snapshot.

**Service** — `tools:registry` (optional). When present at `harness:start`,
registers a zero-argument `status:show` tool that returns the same structured
snapshot used by `/status:show`.

### Events emitted

- `status:item-update` — `{ key, value }`. Emitted per item, only when `value` changes.
- `status:item-clear` — `{ key }`. Emitted on `conversation:cleared` for the items that the clear semantics apply to (`_io`, `tok/s`, `_ctx`, and `cost-estimate` if active).

Both events belong to the `llm-events` VOCAB; this plugin emits them but does not define them.

## Configuration

Cost rates and a handful of display knobs are configured via `config:store`
under the `llm-status-items` section of
`~/.kaizen/harnesses/<key>/config.json`. See the per-field defaults in
`config.ts`. The legacy `~/.kaizen/plugins/llm-status-items/cost-table.json`
file is no longer read — copy your rates into `config.json` by hand.

Example:

```jsonc
{
  "plugins": {
    "llm-status-items": {
      "costRates": {
        "gpt-4.1-mini": { "promptCentsPerMTok": 40, "completionCentsPerMTok": 160 }
      }
    }
  }
}
```

Empty `costRates` (the default) silently disables the `cost-estimate` status
item — fully local sessions emit nothing. Cost is computed as
`(promptTokens * promptCentsPerMTok + completionTokens * completionCentsPerMTok) / 1_000_000`
per `llm:done`, accumulated, and rendered using `costDecimalPlaces`
(default 4) → `$d.dddd`. Models not in the table emit nothing (any prior
`cost-estimate` is cleared).

Other knobs (all optional, defaults shown):
`costDecimalPlaces` (4), `contextBarWidth` (10), `contextBarFillGlyph`
("█"), `contextBarEmptyGlyph` ("░"), `tokensPerSecIntegerThreshold` (10),
`slashCommandEnabled` (true), `toolEnabled` (true). Bar glyphs must render
in one monospace cell or the bar will misalign.

## Slash Command And Tool

`/status:show` prints a human-readable snapshot.

`status:show` takes no arguments:

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

It returns:

```typescript
interface StatusSnapshot {
  model: string | null;
  session: { id: string | null; alias: string | null };
  contextWindow: {
    lastPromptTokens: number;
    contextLength: number | null;
    pctUsed: number | null;
  };
  sessionTotals: {
    promptTokens: number;
    completionTokens: number;
  };
  tokensPerSec: number | null;
  costCents: number | null;
}
```

## Permissions

`tier: trusted` — no filesystem, network, or shell access. (Config I/O lives
inside `kaizen-config`'s permission boundary.)
