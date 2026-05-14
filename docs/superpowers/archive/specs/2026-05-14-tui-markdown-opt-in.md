# Opt-in markdown rendering across the TUI channel

**Status:** draft, awaiting review
**Scope:** `llm-contracts`, `llm-tui`, `llm-driver`, `llm-slash-commands`. `claude-tui` mirror called out as a separate, optional follow-up.

## Goal

Today, `renderMarkdown` runs only on `kind: "output"` transcript entries (the LLM's reply). Everything else — `writeNotice`, `writeUser`, slash-command `ctx.print(...)` output — renders as plain `<Text>`. Slash commands that emit markdown bodies (lists, code blocks, tables) show as literal `*foo*`, raw triple-backtick fences, etc.

This spec makes markdown rendering an **opt-in per write** capability for any text the TUI is asked to display. Callers (driver, slash commands, future plugins) decide whether their text is markdown; the TUI honors the flag end-to-end.

## Non-goals

- **Default-on-everything.** Plain notices and user-typed lines often contain literal `*`/`_`/backticks that would silently mutate. User echo of a typed message is plain text, not markdown. The default for `notice` and `user` stays "plain". `output` keeps its current always-markdown behavior (preserved as the new flag's default).
- **Markdown in tool-call bodies.** Tool calls have their own custom renderers (`tool-renderers/`). Out of scope.
- **Markdown in the live `ThinkingBox` (streaming reasoning).** Streaming partial markdown is genuinely unpleasant: a half-emitted code fence renders as a broken block, an unterminated `*` becomes literal, tables can't render until the trailing `|` row arrives. The live view stays plain on purpose — markdown rendering for thoughts kicks in only after `finalizeReasoning()`. See the "Thoughts rendering" section below.
- **Hot config / per-theme markdown toggles for output/notice/user.** No new theme keys for the three primary kinds; no env var to globally disable. (Thoughts get one theme key as an escape hatch — see below.) If we need a broader kill switch later, add one then.
- **Streaming-aware markdown for `writeOutput`.** `writeOutput` is called many times per turn (delta chunks). Each chunk still renders independently — there is no intermediate buffering that joins deltas before rendering. (Today's behavior; the spec does not change it. Slash commands and notices write the full body in one call, so this only matters for `output`.)
- **`claude-tui` parity.** `claude-tui` has its own private `UiChannelService` shape (`plugins/claude-tui/public.d.ts`). Mirroring this change there is straightforward (same pattern) but out of scope for this spec. Called out in the follow-up section.

## Architecture

### Where the flag lives

A new optional field on the existing write methods and the conversation-system-message payload. No new methods, no new events.

```
caller            event / call                              flag carried as
─────────────     ──────────────────────────────────────    ────────────────────
slash handler  →  ctx.print(text, { markdown: true })    →  opts.markdown
                  ↓
                  emit "conversation:system-message",
                  { message, markdown: true }            →  payload.markdown
                  ↓
llm-driver     →  ui.writeNotice(text, { markdown })     →  opts.markdown
                  ↓
llm-tui        →  store.appendNotice(text, { markdown }) →  entry.markdown
                  ↓
                  App.tsx renderEntry: if entry.markdown
                  call renderMarkdown(entry.text)
```

Driver-written `output` already renders markdown by default; the new contract makes that explicit (default `true` on `writeOutput`) so a caller can opt out with `markdown: false` for, e.g., a raw stdout dump.

### Contract change (`llm-contracts/contracts/ui-channel.ts`)

```typescript
export interface WriteOptions {
  /** Render the text as markdown before display. Default depends on the method:
   *  writeOutput → true (back-compat with current always-on behavior).
   *  writeNotice → false.
   *  writeUser   → false.
   */
  markdown?: boolean;
}

export interface UiChannelService {
  writeOutput(chunk: string, opts?: WriteOptions): void;
  writeNotice(text: string, opts?: WriteOptions): void;
  writeUser(text: string, opts?: WriteOptions): void;
  // …rest unchanged…
}
```

Adding optional params to a public contract is a non-breaking change: existing callers continue to compile and run. The default for `writeOutput` (`markdown: true`) preserves observable behavior bit-for-bit.

### Event payload extension (`conversation:system-message`)

```typescript
// llm-contracts/contracts/events.ts (payload shape — VOCAB stays the same)
interface ConversationSystemMessage {
  message: { role: "system"; content: string };
  /** If true, the UI bridge should pass markdown:true through to writeNotice. */
  markdown?: boolean;
}
```

Optional field; subscribers that don't read it (everything except the driver's UI bridge) are unaffected.

### Slash-command context (`llm-contracts/contracts/slash-registry.ts`)

```typescript
export interface SlashPrintOptions {
  markdown?: boolean;
}

export interface SlashCommandContext {
  // …unchanged…
  print: (text: string, opts?: SlashPrintOptions) => Promise<void>;
}
```

The dispatcher (`plugins/llm-slash-commands/dispatcher.ts`) forwards the flag through the `conversation:system-message` payload.

### Store change (`llm-tui/state/store.ts`)

`PlainTranscriptLine` (and the corresponding append methods) gain an optional `markdown` field:

```typescript
export interface PlainTranscriptLine {
  id: number;
  kind: "output" | "notice" | "user" | "thoughts";
  text: string;
  handoffFrom?: string;
  /** Whether to render the text through renderMarkdown in the UI.
   *  Undefined means "use the kind's default" (output→true, notice/user→false). */
  markdown?: boolean;
}

appendOutput(text, opts?: { markdown?: boolean }): void;
appendNotice(text, opts?: { markdown?: boolean }): void;
appendUser(text, opts?: { markdown?: boolean; handoffFrom?: string }): void;
```

Snapshot identity rules (the `_snapshot` rebuild invariant) are unchanged — entries are still constructed fresh, never mutated.

### Render switch (`llm-tui/ui/App.tsx`)

`renderEntry` consults the per-kind default + the entry's `markdown` flag:

```typescript
const shouldRenderMarkdown = (e: TranscriptLine): boolean => {
  if (e.kind === "output") return e.markdown !== false;        // default on
  if (e.kind === "notice" || e.kind === "user") return e.markdown === true;
  return false;  // thoughts, tool_call — never
};
```

Color wrapping (`<Text color={theme.outputColor}>` for output, `<Text color={theme.noticeColor} dimColor>` for notice, etc.) is preserved. Ink's `<Text>` honors embedded ANSI from `renderMarkdown`, and chalk styles compose correctly when wrapped in an outer color.

One nuance for `notice`: `dimColor` interacts oddly with ANSI bold/colors emitted by marked-terminal. If a markdown notice is rendered, drop `dimColor` for that entry (it's a deliberate signal that the body is structured, not chatty). For plain notices `dimColor` stays.

### Fallback channel (`llm-tui/fallback.ts`)

The fallback channel writes directly to stdout/stderr (no Ink). When `markdown: true` is passed, route the text through `renderMarkdown` first — `marked-terminal` emits ANSI suitable for any terminal stdout, so the output looks the same as in the TTY channel. When the flag is absent or false, write raw as today.

Adding the options bag to the four `UiChannelService` methods on the fallback satisfies the **"Fallback channel matches TTY channel shape"** invariant from `llm-tui/CLAUDE.md`.

### Thoughts rendering (`HistoryView`, `ThoughtsBlock`, `ThinkingBox`)

Thoughts are the fourth `kind` and behave differently from `output`/`notice`/`user` because **the caller of `appendThoughts` doesn't know whether the content is markdown** — reasoning deltas arrive unstructured from the model. The flag therefore is not threaded through `appendReasoning`/`finalizeReasoning`; instead it's a render-time decision driven by a new theme key.

Per-surface behavior:

- **`ThoughtsBlock.tsx` (collapsed-in-chat).** Pure header line ("▶ 💭 Thoughts (N lines)"); no body shown. No change — markdown is irrelevant until the user enters history mode.
- **`ThinkingBox.tsx` (live streaming).** No change. Streaming partial markdown is unstable (broken code fences mid-emission, unterminated emphasis becomes literal). Live view stays plain dim-per-line. This is a deliberate inconsistency with the history view, called out in the "Non-goals" section.
- **`HistoryView.tsx` (expanded thoughts body).** When `isOpen` and `theme.thoughtsMarkdown` is true (default), render the body once via `renderMarkdown(e.text)` inside a single `<Text>`, drop `dimColor`, drop the per-line split. When the theme key is false, keep today's per-line dim rendering verbatim.

Cost / nuances:

- **Memoize per entry-id.** Expand/collapse rerenders the panel; running marked on a multi-hundred-line thoughts blob on every keystroke is wasteful. Memo cache keyed by `entry.id` — entries are immutable once committed (snapshot identity invariant), so the cache never invalidates.
- **`dimColor` is dropped for rendered thoughts**, same as for markdown notices. Plain (theme-disabled) thoughts keep `dimColor`.
- **No flag plumbing through reasoning events.** `appendReasoning` / `finalizeReasoning` / `appendThoughts` signatures don't change. The render-time switch is `theme.thoughtsMarkdown && entry.kind === "thoughts"`.

Theme contract change (`llm-contracts` `UiTheme`):

```typescript
export interface UiTheme {
  // …existing keys…
  /** Render expanded thoughts in HistoryView through the markdown renderer.
   *  Default true. The live ThinkingBox is always plain regardless. */
  thoughtsMarkdown: boolean;
}
```

Default in `llm-tui/theme/loader.ts` `DEFAULT_THEME`: `thoughtsMarkdown: true`.

### Driver bridge (`llm-driver/index.ts`)

The `conversation:system-message` subscriber forwards the markdown flag if present:

```typescript
ctx.on("conversation:system-message", (payload: any) => {
  const text = payload?.message?.content;
  if (typeof text === "string" && text && moduleUi) {
    moduleUi.writeNotice(text, payload.markdown ? { markdown: true } : undefined);
  }
});
```

All other `ui.writeNotice` / `ui.writeOutput` call sites in the driver stay unchanged — their text is not markdown.

### Touch summary

| File | Change |
|---|---|
| `plugins/llm-contracts/contracts/ui-channel.ts` | Add `WriteOptions` interface; thread through `writeOutput`/`writeNotice`/`writeUser` |
| `plugins/llm-contracts/contracts/ui-theme.ts` (or wherever `UiTheme` lives) | Add `thoughtsMarkdown: boolean` |
| `plugins/llm-contracts/contracts/slash-registry.ts` | Add `SlashPrintOptions`; thread through `SlashCommandContext.print` |
| `plugins/llm-contracts/contracts/events.ts` | Add `markdown?: boolean` to `ConversationSystemMessage` payload shape (if documented in types) |
| `plugins/llm-tui/state/store.ts` | Add `markdown?: boolean` to entry + appenders |
| `plugins/llm-tui/theme/loader.ts` | Add `thoughtsMarkdown: true` to `DEFAULT_THEME` and any test fixtures |
| `plugins/llm-tui/ui/App.tsx` | `shouldRenderMarkdown(e)` switch in `renderEntry`; conditional `renderMarkdown` for notice/user/output |
| `plugins/llm-tui/ui/HistoryView.tsx` | When expanded thoughts + `theme.thoughtsMarkdown`: single `<Text>` + `renderMarkdown`, drop `dimColor` and per-line split; memoize by entry id |
| `plugins/llm-tui/index.tsx` | Pass options through `writeOutput`/`writeNotice`/`writeUser` to the store |
| `plugins/llm-tui/fallback.ts` | Accept options; route through `renderMarkdown` when `markdown: true` |
| `plugins/llm-tui/public.d.ts` | (if it re-exports anything affected, sync) |
| `plugins/llm-slash-commands/dispatcher.ts` | `print(text, opts?)` forwards `markdown` into `conversation:system-message` payload |
| `plugins/llm-slash-commands/index.ts` | Mirror the same forward where the plugin emits the event itself (unknown-command path is plain text, no change needed) |
| `plugins/llm-driver/index.ts` | Bridge subscriber forwards `payload.markdown` to `moduleUi.writeNotice(text, opts)` |

Explicitly **unchanged**: `plugins/llm-tui/ui/ThoughtsBlock.tsx`, `plugins/llm-tui/ui/ThinkingBox.tsx`. Both render plain text and the spec keeps them that way.

CLAUDE.md updates: `llm-tui`, `llm-slash-commands`, `llm-contracts` each get one-line invariants documenting the per-kind defaults and the no-default-mutation rule (entries already constructed are never re-rendered with a different flag).

## Invariants

- **Defaults are kind-specific and back-compat.** `output` defaults `markdown: true`; `notice` and `user` default `markdown: false`. The flag is interpreted in the UI; nothing in the contract requires callers to pass it.
- **The flag is a per-entry property, not global state.** Two consecutive `writeNotice` calls with different flags produce two transcript entries that render differently. No "current mode" lives in the store.
- **`renderMarkdown` is best-effort.** It already swallows exceptions and returns the input string verbatim on parser failure. The opt-in flag does not change that — a bad markdown body never crashes the TUI.
- **Color wrapping survives markdown.** The outer `<Text color={...}>` is preserved regardless of the flag. The rendered ANSI from `marked-terminal` is allowed to override per-token (code spans, headings) but the base color stays.
- **`dimColor` is dropped for markdown notices and rendered thoughts.** Plain notices and theme-disabled thoughts keep the dim effect.
- **The flag is opt-in for `output` too.** A caller passing `writeOutput(chunk, { markdown: false })` gets raw text. Useful for `claude-driver`-style stdout passthrough where the LLM is emitting non-markdown payloads (e.g., raw tool output dumps).
- **Thoughts ignore the per-entry `markdown` flag.** Even if `appendThoughts(text, { markdown: true })` were called, the render switch consults `theme.thoughtsMarkdown` instead. This is the deliberate "render-time decision, not write-time" rule that keeps the reasoning-event path from having to know its payload format.
- **The live `ThinkingBox` is always plain.** Theme-disabled thoughts and the live streaming view look the same; theme-enabled thoughts diverge only after `finalizeReasoning()` commits the block.

## Migration

No coordinated deploy needed. All shape changes are additive:

1. Land the contract update + TUI implementation + fallback in one MR. Existing callers compile unchanged; existing behavior is byte-identical.
2. Land the slash-commands dispatcher + driver bridge update in a second MR. `ctx.print(text, { markdown: true })` becomes available to handlers.
3. Adopt per-handler: update the slash commands the user just added to pass `{ markdown: true }`.

Order matters only for **(3) requires (2)**. (1) is standalone.

## Tests

Per-plugin, all under `bun test`:

- `llm-tui/state/store.test.ts`
  - `appendOutput("hi")` produces `{ kind: "output", markdown: undefined }` (default-on at render).
  - `appendNotice("hi", { markdown: true })` produces `{ kind: "notice", markdown: true }`.
  - Two writes with different flags produce two distinct entries.
- `llm-tui/ui/App.test.tsx`
  - Output entry with no flag: rendered output contains ANSI from `renderMarkdown`.
  - Output entry with `markdown: false`: rendered output is the raw string (no escape codes beyond the wrapping color).
  - Notice entry with no flag: plain text, `dimColor` applied.
  - Notice entry with `markdown: true`: ANSI present, `dimColor` not applied.
  - User entry with `markdown: true`: ANSI present.
- `llm-tui/fallback.test.ts` (or add cases to existing tests)
  - `writeNotice("**hi**", { markdown: true })` writes ANSI-styled text to stderr.
  - `writeNotice("**hi**")` writes literal `**hi**` to stderr.
- `llm-slash-commands/test/dispatcher.test.ts`
  - `ctx.print("# hi", { markdown: true })` emits `conversation:system-message` with `markdown: true` on the payload.
  - `ctx.print("hi")` emits without the field (or `markdown: false`/absent).
- `llm-driver` integration test
  - A `conversation:system-message { markdown: true }` event results in `moduleUi.writeNotice(text, { markdown: true })`.
- `llm-tui/ui/HistoryView.test.tsx`
  - Expanded thoughts entry with `theme.thoughtsMarkdown: true`: rendered frame contains ANSI from `renderMarkdown`; `dimColor` not applied to the body.
  - Expanded thoughts entry with `theme.thoughtsMarkdown: false`: rendered frame is per-line plain text with `dimColor` (today's behavior).
  - Collapsing then re-expanding the same entry does not re-run `renderMarkdown` (memo cache test — assert the renderer is called at most once per entry id).
- `llm-tui/theme/loader.test.ts`
  - `DEFAULT_THEME.thoughtsMarkdown === true`.
  - User-supplied `thoughtsMarkdown: false` overrides the default.

## Open questions

1. **Should `writeUser` ever need markdown?** I can't think of a case for human-typed input. The flag exists for symmetry and for synthetic-user-message scenarios (handoff seeds, replay), but if review consensus is "never", drop it from `writeUser` to narrow the surface.
2. **`claude-tui` mirror.** Same pattern, isolated change. Worth doing in the same release for consistency, or punt to a separate spec. Current draft assumes punt.
3. **Thoughts memo cache lifetime.** The expand/collapse memo is keyed by entry id. Entries are immutable once committed, so the cache never invalidates within a session. Reset on session reload happens for free (new store, new cache). No bound on the cache size — a long session could accumulate dozens of rendered thoughts blobs in memory. Probably fine (thoughts text is bounded per turn and we already hold the raw text in the transcript), but call it out for review.

## Follow-ups (not in this spec)

- `claude-tui` parity: same options on its `UiChannelService` and fallback.
- Live `ThinkingBox` markdown rendering (would require either per-delta full re-parse or a streaming-aware markdown renderer; neither exists in `marked-terminal` today).
- Per-model `markdown` hint on `llm:reasoning` payloads if a model is found that emits markdown CoT but where best-effort always-on rendering produces noticeably worse output than plain.
- A theme key (`markdownGutter`, `markdownCodeBg`, etc.) if users start asking for color customization of the marked-terminal output.
