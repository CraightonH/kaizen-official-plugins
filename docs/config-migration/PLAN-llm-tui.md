# PLAN: `llm-tui` config:store migration

## Current state

`llm-tui` is **partially migrated already**: theme tokens are registered with
`config:store` under the plugin name `"llm-tui"` using the cross-plugin
`UiTheme` contract as the config shape.

- `plugins/llm-tui/package.json:13-21` — declares `services.consumes = ["events:vocabulary", "config:store"]` (already wired).
- `plugins/llm-tui/index.tsx:42-72` — reads `ctx.config.theme` for harness-supplied defaults, then calls `cfgStore.register<UiTheme>({ plugin: "llm-tui", defaults, schema: THEME_SCHEMA })`, `get()`, and `watch()` for live theme updates.
- `plugins/llm-tui/theme/schema.ts:12-30` — `BUILT_IN_THEME` (defaults) + `THEME_SCHEMA` (validation). Fields: `promptLabel`, `promptColor`, `outputColor`, `noticeColor`, `busyColor`, `statusBarColor`, `thoughtsMarkdown`.
- `plugins/llm-contracts/contracts/ui-theme.ts:4-17` — `UiTheme` contract (already includes `thoughtsMarkdown`).

No `process.env.*` reads remain. No custom config-file readers remain. No
legacy `~/.kaizen/plugins/llm-tui/config.json` path (the README still mentions
it but the code path is gone — the README will need a documentation pass
during execution, not in this plan).

### Remaining hardcoded tunables (candidates)

Non-theme constants the user might plausibly want to tune:

| Const | File:line | Default | Notes |
|---|---|---|---|
| completion popup debounce | `completion/registry.ts:21` | `50` ms | Currently a `makeCompletionRegistry()` opt arg; nothing in `index.tsx` overrides it. |
| popup visible rows | `ui/CompletionPopup.tsx:5` | `8` | "… N more" overflow row beyond this. |
| Ctrl+C exit window | `ui/InputBox.tsx:24` | `2000` ms | Two-step exit grace period. |
| thinking tail lines | `ui/ThinkingBox.tsx:4` | `5` | How many trailing lines of live reasoning stay visible above the input. |
| agent activity cap | `state/store.ts:59` (`AGENT_ACTIVITY_CAP`) | `5` | Max sub-agent activity rows under a `dispatch_agent` tool-call. |
| tool result preview length | `tool-renderers/util.ts:1` (`MAX_PREVIEW`) | `80` chars | Used by the collapsed tool-call summary line. |
| tool expanded line width | `tool-renderers/defaults.tsx:7` (`MAX_LINE_WIDTH`) | `200` chars | Per-line truncation in expanded views. |
| tool expanded preview lines | `tool-renderers/defaults.tsx:6` (`PREVIEW_LINES`) | `10` | Rows shown for `bash`/`edit`/`write`/`create` expanded view. |
| fallback JSON truncation | `tool-renderers/registry.ts:32` | `1500` | Bytes shown for unknown-tool args/result JSON in expanded view. |

None are policy-critical; all are pure UX-density knobs. They are reasonable
to expose but the user has not asked for any of them today, and they live
across enough files that a migration would touch most of the UI module set.

## Proposed `LlmTuiConfig`

Two viable shapes; recommendation in the next section.

```ts
// Option A — extend the existing config section with a sibling object.
// Theme stays where it is (top-level fields of llm-tui's config), and the
// non-theme knobs live under llm-tui.ux.*.
// This keeps the UiTheme contract surface intact (no contract change).
export interface LlmTuiConfig extends UiTheme {
  completionDebounceMs: number;     // 50
  completionMaxVisible: number;     // 8
  ctrlCExitWindowMs: number;        // 2000
  thinkingTailLines: number;        // 5
  agentActivityCap: number;         // 5
  toolPreviewChars: number;         // 80
  toolExpandedLineWidth: number;    // 200
  toolExpandedPreviewLines: number; // 10
  toolFallbackJsonChars: number;    // 1500
}
```

Option B (rejected): introduce a nested `ux: {...}` sub-object under
`llm-tui`. Cleaner namespacing, but `config:store` shallow-merges only at the
top level, so nesting under `ux` means a single user override of e.g.
`ctrlCExitWindowMs` would have to re-supply the whole `ux` block. Flat is
better.

## Defaults and schema

```ts
// plugins/llm-tui/config.ts (NEW)
import type { FieldSchema, UiTheme } from "llm-contracts/public";
import { BUILT_IN_THEME, THEME_SCHEMA } from "./theme/schema.ts";

export interface LlmTuiConfig extends UiTheme {
  completionDebounceMs: number;
  completionMaxVisible: number;
  ctrlCExitWindowMs: number;
  thinkingTailLines: number;
  agentActivityCap: number;
  toolPreviewChars: number;
  toolExpandedLineWidth: number;
  toolExpandedPreviewLines: number;
  toolFallbackJsonChars: number;
}

export const DEFAULT_CONFIG: LlmTuiConfig = Object.freeze({
  ...BUILT_IN_THEME,
  completionDebounceMs: 50,
  completionMaxVisible: 8,
  ctrlCExitWindowMs: 2000,
  thinkingTailLines: 5,
  agentActivityCap: 5,
  toolPreviewChars: 80,
  toolExpandedLineWidth: 200,
  toolExpandedPreviewLines: 10,
  toolFallbackJsonChars: 1500,
}) as LlmTuiConfig;

export const CONFIG_SCHEMA: Record<keyof LlmTuiConfig, FieldSchema> = {
  ...THEME_SCHEMA,
  completionDebounceMs:    { type: "number", min: 0,  max: 2000, integer: true },
  completionMaxVisible:    { type: "number", min: 1,  max: 32,   integer: true },
  ctrlCExitWindowMs:       { type: "number", min: 250,max: 10000,integer: true },
  thinkingTailLines:       { type: "number", min: 1,  max: 50,   integer: true },
  agentActivityCap:        { type: "number", min: 1,  max: 50,   integer: true },
  toolPreviewChars:        { type: "number", min: 20, max: 500,  integer: true },
  toolExpandedLineWidth:   { type: "number", min: 40, max: 1000, integer: true },
  toolExpandedPreviewLines:{ type: "number", min: 1,  max: 200,  integer: true },
  toolFallbackJsonChars:   { type: "number", min: 100,max: 50000,integer: true },
};
```

## Code changes

1. **New file** `plugins/llm-tui/config.ts` with `DEFAULT_CONFIG`,
   `CONFIG_SCHEMA`, `LlmTuiConfig`. Re-exports `BUILT_IN_THEME` /
   `THEME_SCHEMA` indirectly via spread.
2. **`plugins/llm-tui/public.d.ts`** — export `LlmTuiConfig` (plugin-private;
   nobody else needs to consume it, but keeps the public surface centralised).
3. **`plugins/llm-tui/index.tsx`** — replace the current `UiTheme` register
   with `register<LlmTuiConfig>(...)`. Keep the same plugin name `"llm-tui"`
   so existing on-disk theme overrides survive. The watch callback still
   only pushes `UiTheme` fields into `store.setTheme()`; UX-knob updates need
   one of:
   - **A.** Pass the full `LlmTuiConfig` into `TuiStore` and have it expose
     getters that the UI components read on each render. Components currently
     hardcode the constants — they'd swap to `state.config.<field>`.
   - **B.** Push the UX knobs to module-level setters (`setCtrlCExitWindow`,
     etc.) called from the watch callback. Avoids threading config through
     every component but spreads mutable module state.
   - **Recommend A.** Store-driven config is consistent with how `theme` is
     already plumbed through snapshots. Components already subscribe via
     `useSyncExternalStore`.
4. **Component edits** — replace the hardcoded constants with snapshot reads:
   - `ui/InputBox.tsx` — read `ctrlCExitWindowMs` from snapshot.
   - `ui/CompletionPopup.tsx` — read `completionMaxVisible`.
   - `ui/ThinkingBox.tsx` — read `thinkingTailLines`.
   - `state/store.ts` — `AGENT_ACTIVITY_CAP` becomes a per-store field set
     from config; the existing tests pin the constant and will need a
     parametrised setup helper.
   - `tool-renderers/util.ts`, `tool-renderers/defaults.tsx`,
     `tool-renderers/registry.ts` — `defaultRenderers(getTheme)` already
     takes a callback for the theme; widen it to `getConfig: () => LlmTuiConfig`
     and read the tool preview/width/lines fields from it.
   - `completion/registry.ts` — already accepts `debounceMs` opt; pass
     `config.completionDebounceMs` from `index.tsx` (no internal change).
     **Live updates won't apply to debounce** because the registry captures
     the value at construction; documented limitation, restart picks it up.
5. **Tests** — adjust the constants in tests that lock specific values
   (`completion/registry.test.ts` for debounce, `ui/CompletionPopup.test.tsx`
   for visible rows). Most can keep using the default-config value.

## Manifest changes

None. `services.consumes` already includes `"config:store"`. No new
`fs.read`/`fs.write` permissions needed (still `tier: unscoped`, which the
README accurately attributes to terminal raw-mode, not config I/O).

## Risks / open questions

- **Scope creep vs. user need.** None of these constants have generated a
  user complaint that I'm aware of. The migration touches ~7 files and adds
  a config surface the user may never edit. Consider deferring everything
  except possibly `ctrlCExitWindowMs` (most-likely-tuned by power users) and
  `completionDebounceMs` (visible perf knob) until a user actually asks.
- **Debounce live-update gap.** `completion/registry.ts` reads `debounceMs`
  at construction time; live-updating it would require either re-creating
  the registry (destructive — loses registered sources) or threading a
  getter through the closure. Restart-to-apply is the pragmatic choice;
  document it in the field's help text.
- **`AGENT_ACTIVITY_CAP` is exported** (`state/store.ts:59`) and could in
  principle be imported by another plugin. `grep` across `plugins/` should
  confirm no external import before demoting it to a config field. If used
  externally, leave it as a fallback constant and treat `config.agentActivityCap`
  as the source of truth at call sites.
- **README drift.** The "Configuration" table in
  `plugins/llm-tui/README.md:158-163` still documents the now-defunct
  `~/.kaizen/plugins/llm-tui/config.json` and `KAIZEN_LLM_TUI_CONFIG` env
  var. Whether or not the UX knobs land, this section needs rewriting to
  point at `config:store` and the harness `config.json`. Strictly an
  execution-time fix, not part of the plan's schema work.
- **`thoughtsMarkdown` already lives on the `UiTheme` contract**, so it's
  out of scope here — no new contract proposal needed for the theme half.

## Contract proposals (only if needed)

None required.

- The seven non-theme UX knobs are plugin-private (only `llm-tui`'s own UI
  components read them). They do not cross plugin boundaries, so they
  belong in `plugins/llm-tui/public.d.ts`, not in `llm-contracts`.
- If a future plugin wanted to influence, say, the tool-preview width
  contract-wide, the right move would be to extend `UiTheme` (the
  cross-plugin UI surface) — but that's speculation, not warranted now.
