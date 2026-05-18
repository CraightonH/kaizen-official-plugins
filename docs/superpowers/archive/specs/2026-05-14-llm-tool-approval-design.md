# `llm-tool-approval` — Design

**Status:** draft
**Date:** 2026-05-14
**Scope:** A new plugin (`llm-tool-approval`) that intercepts every tool call in the openai-compatible harness and gates it on user approval. The plugin reuses the existing `tool:before-execute` cancellation contract, adds a generic modal-prompt UI contract (`ui:prompt`), and lets users persist allow/deny rules incrementally from the prompt itself.
**Depends on:** Spec 0 foundation contracts (`tool:before-execute`, `CANCEL_TOOL`, `tools:registry`). Extends two existing contracts (`tools:registry`, `ui:tool-renderer`) and adds one new contract (`ui:prompt`).

## Goal

Give the user a fast, visible veto over every tool call the LLM emits, with three persistence levels surfaced in the prompt itself ("once" / "always for this tool" / "always for this domain"), so the gate scales with use instead of degrading into prompt fatigue.

## Non-goals (v0)

- Per-argument matching (Claude Code's `Bash(npm run *)` granularity). Tool-call args are arbitrary JSON in our model; pattern syntax doesn't map cleanly. Hand-edited config supports tool-name globs only.
- Symmetric "Deny Always" / "Deny Domain Always" prompt options. The config schema includes `deny` for hand edits, but the prompt never writes there.
- Permission modes beyond a single in-session pause toggle. Claude Code's `default` / `plan` / `acceptEdits` / `bypassPermissions` are out of scope.
- LLM-judge "auto" approval (i.e., a sibling plugin that decides via a sub-conversation). The architecture supports it as a separate `tool:before-execute` subscriber later; this plugin doesn't try to do both.
- Persistent paused state. Pause is session-only.
- A dedicated approval audit log. The transcript echo on resolve is the audit trail.
- Migrating to tag-driven safety on `ToolSchema` (e.g., `safety: "safe" | "destructive"`). Tagged registration is the right long-term answer but requires touching every tool publisher. v0 uses a shipped `defaults.json` instead.

## Architectural overview

The plugin owns three concerns:

1. **Interception.** Subscribe to `tool:before-execute` after `llm-hooks-shell` in the manifest. Apply the resolution rules (paused, deny, allow, prompt). If denied, set `payload.args = CANCEL_TOOL` and `payload.cancelReason` on the bus payload. The registry surfaces both back to the LLM via `tool:error`.

2. **Prompting.** Consume the new `ui:prompt` service to display a modal above the input box, with four terminal options (Approve Once / Approve Always / Approve Domain Always / Deny). The Deny option supports Tab-to-expand into an inline reason text field that becomes `cancelReason`.

3. **Persistence.** Maintain `{ allow: string[], deny: string[] }` rule lists across three sources: shipped `defaults.json`, global config, project config. The "Always" options write to the project file (or global if there's no project context). Rules are exact-string matches or trailing-segment prefix globs (`mcp:github:*`).

Two existing plugins gain small, additive changes; one new contract; one new plugin.

## Plugin: `llm-tool-approval`

### Lifecycle

- **Setup:** Read all three config sources. Read `ui:prompt`, `ui:tool-renderer`, `ui:channel`, `ui:status`, and `slash:registry` services. Register three slash commands. Subscribe to `tool:before-execute`. Emit a `status:item-update` for the `approval` status item. If `ui:prompt` is unavailable, log an error and arrange to auto-deny all calls.
- **Teardown:** Unregister the bus subscriber and all slash commands. Clear the status item.

### Subscriber logic

Run on each `tool:before-execute` event, in order:

1. If `payload.args === CANCEL_TOOL`: another subscriber already cancelled the call; return immediately.
2. If the session is paused: return (no-op; call proceeds).
3. Resolve effective rules (merge `defaults.json`, global, project; see *Resolution order* below):
   - Any source's `deny` matches → set `payload.args = CANCEL_TOOL`, `payload.cancelReason = "Denied by allow/deny config rule."`, write a notice (`✗ approval gate: <name> denied by rule`), return.
   - Any source's `allow` matches → return (no-op).
4. Otherwise call `uiPrompt.requestOption({...})` and await the user's choice:
   - `approve-once`: return.
   - `approve-always`: write `name` into the project (or global, see *Persistence target*) `allow` list and reload config in memory; return.
   - `approve-domain-always`: derive `domain` from `name` (see *Domain derivation*), write into `allow`, reload; return.
   - `deny`: set `payload.args = CANCEL_TOOL`. Set `payload.cancelReason = text || "User denied this tool call."` where `text` is the optional reason returned with the Deny resolution. Write a notice summarizing the denial (and reason if present).

The subscriber is `async`; the bus is sequential and awaits subscribers, so concurrent tool calls naturally serialize through one prompt at a time.

### Prompt body construction

`uiPrompt.requestOption(...)` is called with:

- `title`: `"Approve tool call?"`
- `body`: result of `uiToolRenderer.summarize(name, args)` — one-liner from a registered renderer, or `name + "\n" + JSON.stringify(args, null, 2)` truncated to ~1500 chars.
- `options`: in order — Approve Once, Approve Always, Approve Domain Always (hidden if no domain), Deny.
- `defaultId`: `"approve-once"`.
- `cancelId`: `"deny"`.

Each option's `label` includes the literal target string in parentheses where applicable:
- `Approve Once          (mcp:github:list_issues)`
- `Approve Always        (mcp:github:list_issues)`
- `Approve Domain Always (mcp:github:*)`
- `Deny                  (Tab for reason)`

The Deny option carries `expandsTo: { kind: "text", placeholder: "Reason (optional)" }`.

### Config

#### Schema

```json
{
  "allow": ["mcp:github:*", "fs:read_file"],
  "deny": ["fs:delete_file"]
}
```

Both arrays are optional; missing means empty. Unknown keys are ignored (forward-compat).

#### Sources

| Path | Role | Writability |
|---|---|---|
| `<plugin-package>/defaults.json` | Shipped baseline (curated safe-list) | Read-only by plugin |
| `~/.kaizen/plugins/llm-tool-approval/config.json` | Global user config | User-managed; also the fallback write target |
| `<cwd>/.kaizen/plugins/llm-tool-approval/config.json` | Project config | User-managed; primary write target for prompt-driven rules |

`defaults.json` ships with a curated list of obviously-safe tools (e.g., `llm-skills:*`, `llm-memory:get`, `llm-memory:list`, `execute_typescript`). The final shipped list is decided during implementation; the schema is the load-bearing decision here.

#### Resolution order

For each tool call:

1. If any source has a `deny` entry matching `name` → cancel.
2. Else if any source has an `allow` entry matching `name` → pass.
3. Else → prompt.

Within each rule list, an entry matches `name` iff:

- The entry equals `name` exactly, OR
- The entry is the catch-all `*`, OR
- The entry has the form `<prefix>:*` and `name` starts with `<prefix>:`. The `*` must be the entire final segment after a `:`; nothing else is glob.

`*` alone matches every tool (catch-all bypass for headless / scripted runs).

#### Persistence target

"Approve Always" / "Approve Domain Always" writes go to:

- **Project file** if `<cwd>/.kaizen/` exists. The plugin creates `<cwd>/.kaizen/plugins/llm-tool-approval/` on demand if not present (only when about to write — never on startup).
- **Global file** otherwise.

The plugin never edits `defaults.json`.

Writes are atomic: write to `config.json.tmp`, `fsync`, `rename`. Existing entries are deduped after merge. Entries are sorted alphabetically for stable diffs.

On write failure (permissions, disk full): catch, write a notice `"Failed to persist approval rule: <err>. This call was approved one-time."`, still resolve as approve-once so the foreground intent isn't lost.

After a successful write, reload the source file in-memory so the next call sees the new rule without restart.

#### Domain derivation

Given a tool name `name`:

1. Let `i` = index of the **last** `:` in `name`.
2. If `i < 0` (no `:` in `name`): no domain; hide the "Approve Domain Always" option for this call.
3. Else: `domain = name.slice(0, i + 1) + "*"`.

Examples:

- `mcp:github:list_issues` → `mcp:github:*`
- `mcp:github:create_issue` → `mcp:github:*` (same domain)
- `fs:read_file` → `fs:*`
- `execute_typescript` → no domain
- `a:b:c:d` → `a:b:c:*`

The "Approve Domain Always" prompt always derives exactly one domain — never coarser. Users wanting coarser rules (e.g., `mcp:*`) hand-edit the config.

### Slash commands

All three are namespaced per the harness invariant on bare names.

| Command | Effect |
|---|---|
| `/approval:pause` | Sets in-memory `paused = true`. Updates status item to `approval: paused`. Writes notice. Idempotent. |
| `/approval:resume` | Sets `paused = false`. Updates status item to `approval: request`. Writes notice. Idempotent. |
| `/approval:status` | Writes a notice listing: pause state, per-source counts (allow/deny), effective merged rules, and the destination path for the next "Approve Always" write. |

### Status item

The plugin owns one status item: key `approval`, value `approval: request` (active, prompting) or `approval: paused`. Updates flow through the existing `status:item-update` event. The status item is set on plugin start and cleared on teardown.

### Error handling

| Condition | Behavior |
|---|---|
| Config file unreadable / malformed JSON | Log warning, treat as `{ allow: [], deny: [] }`. Write a one-time startup notice. |
| Config write failure | Notice + fall through as approve-once. |
| `ui:prompt` service missing on startup | Log error; auto-deny every call with `cancelReason = "approval gate misconfigured: no ui:prompt service"`. Visible failure beats silent bypass. |
| Tool name not a string or empty | Treat as no-domain (option hidden); exact-match against rules; never crash. |
| No TTY (fallback channel) | Per the contract, `ui:prompt` resolves immediately to `cancelId` → auto-deny. Users running headless put `*` into `allow` deliberately. |

## Contract: `ui:prompt` (new, in `llm-contracts`)

A generic modal-prompt service. Cardinality-one. Single implementer: `llm-tui`. Single primary consumer: `llm-tool-approval`. Designed to outgrow that — surveys, destructive-action confirmations, and future "auto" approval prompts can reuse the same modal.

### Types

```ts
export interface UiPromptOption {
  id: string;
  label: string;
  /**
   * If set, Tab on this option expands an inline text field below it; Enter
   * then submits with both the option id and the typed text. Esc collapses
   * back to the option list (text is discarded).
   */
  expandsTo?: { kind: "text"; placeholder?: string; defaultValue?: string };
}

export interface UiPromptOptionsRequest {
  title: string;
  body: string;
  options: ReadonlyArray<UiPromptOption>;
  /** Initial selection id; defaults to options[0].id. */
  defaultId?: string;
  /** Esc at the top level resolves with this id; defaults to options.at(-1).id. */
  cancelId?: string;
}

export interface UiPromptTextRequest {
  title: string;
  body?: string;
  placeholder?: string;
  defaultValue?: string;
}

export interface UiPromptService {
  /** Resolves to { id } unless the chosen option expanded a text field. */
  requestOption(req: UiPromptOptionsRequest): Promise<{ id: string; text?: string }>;
  /** Standalone text prompt. Esc → empty string. */
  requestText(req: UiPromptTextRequest): Promise<string>;
}

export const CONTRACT_ID = "ui:prompt" as const;
export const DESCRIPTION = "Modal prompt above the input box for option choices and free-form text.";
```

The TUI implementation is interactive; non-TTY environments resolve immediately to the cancel/empty outcome. Callers must tolerate this.

## Contract change: `tools:registry`

Extend the `tool:before-execute` event payload with an optional `cancelReason` field. Formalize the payload type (currently inlined in `registry.ts`) and re-export from `llm-contracts/public`.

```ts
export interface ToolBeforeExecutePayload {
  name: string;
  args: unknown;      // subscribers may overwrite to mutate args, or to CANCEL_TOOL to cancel
  callId: string;
  turnId?: string;
  sessionId?: string;
  /**
   * Optional human-readable reason. Used by the registry as the `tool:error`
   * message when `args === CANCEL_TOOL`. Defaults to "cancelled by subscriber"
   * if absent. Existing subscribers that don't set this field see no behavior
   * change.
   */
  cancelReason?: string;
}
```

This is additive and back-compatible. Every existing subscriber works unchanged.

## Contract change: `ui:tool-renderer`

Add one method to the existing service:

```ts
export interface UiToolRendererService {
  register(renderer: UiToolRenderer): () => void;
  /** Returns the collapsed one-line summary, or a JSON fallback if no renderer is registered. */
  summarize(name: string, args: unknown): string;
}
```

Implementation: if a renderer is registered for `name`, return `renderer.collapsedSummary(args)`. Otherwise return `name + "\n" + JSON.stringify(args, null, 2)` truncated to ~1500 chars with `… (N more chars)` suffix if truncated.

## Implementation: `llm-tools-registry`

Single behavior change in `registry.ts`'s `invoke()`:

```ts
if (beforePayload.args === CANCEL_TOOL) {
  const message = beforePayload.cancelReason ?? "cancelled by subscriber";
  await emit("tool:error", { name, callId: ctx.callId, message, ...scoped });
  const err = new Error(message);
  (err as any).name = "AbortError";
  throw err;
}
```

Re-export `ToolBeforeExecutePayload` from `llm-contracts/public`. All existing tests pass unchanged; a new test verifies the `cancelReason` flow.

## Implementation: `llm-tui`

### `TuiStore` prompt slice

```ts
type PromptSlice =
  | null
  | {
      kind: "options";
      request: UiPromptOptionsRequest;
      selectedIndex: number;
      expanded: { id: string; text: string } | null;
      resolve: (result: { id: string; text?: string }) => void;
    }
  | {
      kind: "text";
      request: UiPromptTextRequest;
      text: string;
      resolve: (text: string) => void;
    };
```

Reducers (pure):

- `openOptionsPrompt(req, resolve)` — open with `selectedIndex = indexOf(defaultId)` or 0, `expanded = null`.
- `openTextPrompt(req, resolve)` — open with `text = req.defaultValue ?? ""`.
- `moveSelection(delta)` — bounded ±1 over `request.options.length`.
- `tabExpand()` — only if the selected option has `expandsTo`. Sets `expanded = { id, text: expandsTo.defaultValue ?? "" }`.
- `collapseExpansion()` — sets `expanded = null` (discards text).
- `setExpandedText(text)` / `setStandaloneText(text)` — full replacement (component supplies new value, no incremental ops in the store).
- `submitPrompt(result)` — appends transcript echo, calls `resolve`, clears the slice.
- `escapePrompt()` — resolves with `cancelId` (options) or `""` (text).

Snapshot identity is rebuilt on every mutation per the existing store invariant.

### `<PromptBox>` component

New file `ui/PromptBox.tsx`. Placement in `App.tsx`: above `<InputBox>`, below the LiveToolCalls / ThinkingBox / SpinnerLine cluster. Renders nothing when `snap.prompt === null`.

Layout — options mode:

```
┌─ Approve tool call? ────────────────────────────┐
│ mcp:github:list_issues                           │
│ { "state": "open" }                              │
│                                                  │
│   Approve Once          (mcp:github:list_issues) │
│   Approve Always        (mcp:github:list_issues) │
│ ▸ Approve Domain Always (mcp:github:*)           │
│   Deny                  (Tab for reason)         │
└──────────────────────────────────────────────────┘
```

Layout — expanded (Tab on Deny):

```
│ ▸ Deny                                           │
│     Reason: ▏                                    │
│             Enter to submit · Esc to collapse    │
```

Layout — standalone text:

```
┌─ <title> ────────────────────────────────────────┐
│ <body, if present>                               │
│                                                  │
│ ▏ <placeholder>                                  │
│   Enter to submit · Esc to skip                  │
└──────────────────────────────────────────────────┘
```

### Keystroke routing

Per the existing TUI invariant ("all keys in `InputBox`"), `<InputBox>`'s `useInput` handler branches at the top on `snap.prompt`. Pseudocode:

```
if snap.prompt:
  if prompt.kind === "options" && !prompt.expanded:
    Up/Down → moveSelection
    Enter   → submitPrompt({ id: options[selectedIndex].id })
    Tab     → if options[selectedIndex].expandsTo: tabExpand()
    Esc     → submitPrompt({ id: cancelId ?? options.at(-1).id })
  else if prompt.kind === "options" && prompt.expanded:
    Printable → setExpandedText(text + ch)
    Backspace → setExpandedText(text.slice(0, -1))
    Enter     → submitPrompt({ id: expanded.id, text: expanded.text })
    Esc       → collapseExpansion()
  else if prompt.kind === "text":
    Printable → setStandaloneText(text + ch)
    Backspace → setStandaloneText(text.slice(0, -1))
    Enter     → submitPrompt(text)
    Esc       → submitPrompt("")
  return (suppress normal input handling)
```

While a prompt is active, the completion popup, Ctrl+R history mode, and Ctrl+X copy chord are all suppressed.

### Transcript echo on resolve

`submitPrompt` appends a transcript entry before resolving. Format (notice kind, markdown:false):

- Options without expansion: `? <title> → <selected label>`
- Options with expansion submitted: `? <title> → <selected label>: <text>`
- Options resolved via Esc: same as no-expansion form
- Text prompt: `? <title> → <text>` or `? <title> → (skipped)`

The notice carries an icon/color from the existing theme (notice color).

### `ui:prompt` service implementation

In `index.tsx`, define and provide the service:

```ts
const uiPrompt: UiPromptService = {
  requestOption(req) {
    return new Promise((resolve) => {
      store.openOptionsPrompt(req, resolve);
    });
  },
  requestText(req) {
    return new Promise((resolve) => {
      store.openTextPrompt(req, resolve);
    });
  },
};
ctx.provideService<UiPromptService>("ui:prompt", uiPrompt);
```

### Fallback channel

Add to `fallback.ts` to keep the channel shape invariant intact:

```ts
const uiPrompt: UiPromptService = {
  async requestOption(req) {
    return { id: req.cancelId ?? req.options.at(-1)!.id };
  },
  async requestText() {
    return "";
  },
};
```

The fallback channel doesn't print anything for prompts; the caller is responsible for writing notices.

## Wiring

Add `official/llm-tool-approval@0.1.0` to `harnesses/openai-compatible.json`. **Ordering matters:** the plugin must load after `llm-hooks-shell` so that hooks pre-empt the prompt for already-known-bad calls. Place it last among the plugins that subscribe to `tool:before-execute`.

Recommended insertion point in the manifest:

```jsonc
"official/llm-hooks-shell@0.1.1",
"official/llm-tool-approval@0.1.0",   // new — must come after hooks-shell
```

## Testing strategy

### `llm-tool-approval`

- Unit (match logic): exact, prefix-glob, multi-segment names, catch-all `*`, conflicting allow+deny (deny wins), unknown / empty / non-string tool names.
- Unit (subscriber): each terminal option produces the right `payload.args` / `payload.cancelReason` mutation; "always" options trigger the right config write; paused short-circuits; pre-cancelled call (`CANCEL_TOOL` already set) skips prompting.
- Unit (config): three-source merge order, atomic write + reload, write-failure fallthrough, project vs global target selection.
- Unit (slash commands): each command mutates state correctly and emits the right notice/status item.
- Integration: with the real `tools:registry`, a fake `ui:prompt`, and a fake tool — Deny produces `tool:error` with the expected `cancelReason`.

### `llm-tui` (new `ui:prompt`)

- `state/store.test.ts` adds prompt-slice reducer tests: open both kinds; navigate; Tab-expand; type; submit; Esc behavior in each mode; transcript echo content per outcome.
- New `ui/PromptBox.test.tsx` with `ink-testing-library`: snapshot tests for options mode, expanded mode, text mode; selection indicator; CJK width hold (consistent with the existing CJK invariant on the completion popup).
- Keypress gating test: while a prompt is active, completion popup and chord shortcuts no-op.
- Fallback channel test: `requestOption` resolves to `cancelId`; `requestText` resolves to `""`.

### `llm-tools-registry`

- Existing tests stay green (additive change).
- New test: subscriber sets `cancelReason = "X"` → emitted `tool:error.message === "X"` and the rejected `AbortError.message === "X"`.
- Existing "no cancelReason → `cancelled by subscriber`" assertion still passes.

### `llm-contracts`

- Type-only tests asserting `UiPromptService` and `ToolBeforeExecutePayload` shapes are exported.

## Open extension points (called out, not built)

- **Tag-driven safety on `ToolSchema`.** When the ecosystem stabilizes on tool-author intent (`safety: "safe" | "destructive"`), the approval gate can prefer tags over the shipped `defaults.json`. Migration is non-breaking: tags become an additional source in the resolution chain.
- **LLM-judge "auto" approval as a sibling plugin.** Another `tool:before-execute` subscriber that runs a sub-conversation against the recent transcript to decide allow/deny. Fits the same contract; no changes to this plugin.
- **Persistent paused state.** A `paused: bool` field on the config, with a startup notice when persistently paused.
- **Symmetric "Deny Always" / "Deny Domain Always" prompt options.** Easy to add; deferred until use proves it's needed.
- **Richer `ui:prompt` request kinds.** Multi-field forms, checkbox lists, etc. The two-method contract (`requestOption`, `requestText`) was chosen so each kind stays simple; adding `requestForm` is additive.
