# TUI Markdown Rendering + Copy Latest Message

**Status:** approved design, awaiting plan
**Scope:** `plugins/llm-tui` only — no driver, contract, or event changes
**Tracking:** `docs/todo.md` item #2

## Goal

Render assistant messages as styled markdown by default, and bind `Ctrl+X` to
copy the raw markdown source of the most recent assistant message to the OS
clipboard. Advertise the keybind via the status bar.

## Non-goals

- Streaming-time markdown rendering. The driver already buffers and flushes the
  whole assistant message in one `writeOutput` call at end-of-turn
  (`llm-driver/index.ts:248`), so each turn is already one transcript entry.
- A "copy rendered" shortcut. The raw markdown copy re-renders losslessly in
  any markdown-aware target, and the styled ANSI form is rarely useful as
  paste output. Cancelled during brainstorm.
- Heuristic markdown detection. Markdown is a superset of plain prose; the
  renderer is applied unconditionally to `kind: "output"` entries. The copy
  shortcut is the escape valve for any case where rendering is unwanted.

## Architecture

Three additions, all local to `llm-tui`:

1. Markdown rendering of `kind: "output"` transcript entries at render time.
   The store keeps the raw markdown text; the transformation lives in
   `App.tsx`'s render function only.
2. A `Ctrl+X` keybind in `InputBox` that copies the most-recent `kind:
   "output"` entry's raw text to the OS clipboard.
3. A persistent status-bar entry advertising the keybind, emitted by the TUI's
   `setup()` via the existing `status:item-update` event.

No contract changes. No new events. No changes to other plugins.

## Components

| File | Change |
|---|---|
| `ui/markdown.ts` *(new)* | `renderMarkdown(src: string): string` — `marked` + `marked-terminal`, configured once at module load. Returns an ANSI-styled string. Try/catch returns the input verbatim on failure. |
| `clipboard.ts` *(new, top-level)* | `copyToClipboard(text: string): Promise<CopyResult>` where `CopyResult = { ok: boolean; via: "pbcopy" \| "xclip" \| "clip" \| "osc52" \| "none"; error?: string }`. Platform-to-CLI mapping: darwin → `pbcopy`, linux → `xclip -selection clipboard` (with `xsel --clipboard --input` as a secondary if `xclip` is missing), win32 → `clip.exe`. Tries the platform CLI first via `Bun.spawn`; on missing binary or non-zero exit, falls back to writing the OSC 52 escape sequence to stdout. Pure (no React, no `ctx`). |
| `ui/App.tsx` | The `kind: "output"` branch of `renderEntry` routes `e.text` through `renderMarkdown` and returns `<Text>{styled}</Text>`. Ink honors embedded ANSI in `<Text>`. User / notice / thoughts / tool_call branches unchanged. |
| `ui/InputBox.tsx` | New handler placed before the existing `if (key.ctrl) return` guard: `if (key.ctrl && input === "x") { copyLatest(); return; }`. Reads the latest output from the store, calls `copyToClipboard`, posts a result notice via `store.appendNotice`. |
| `state/store.ts` | New accessor `latestOutputText(): string \| null` — reverse-scan `_transcript`, return the `text` of the first `kind: "output"` entry, else `null`. |
| `index.tsx` | On `setup()`, emit `status:item-update` with `{ key: "tui:hint:copy", value: "⌃X copy last" }`. Never cleared. |
| `package.json` | Add `marked` and `marked-terminal` dependencies. |

## Data flow

### Render path (per `kind: "output"` entry)

```
driver.writeOutput("\n" + text + "\n")
  → store.appendOutput
  → snapshot
  → App.tsx renderEntry
  → renderMarkdown(e.text)         // ANSI-styled string
  → <Text>{styled}</Text>          // inside <Static>
```

`<Static>` commits each entry once. The raw markdown stays in the store
(available to the copy path); ANSI exists only in the rendered output.

### Copy path (Ctrl+X)

```
InputBox key handler
  → store.latestOutputText()
  → null?  store.appendNotice("nothing to copy yet")
  → text?  copyToClipboard(text)
       → ok:    store.appendNotice(`copied ${n} chars · via ${via}`)
       → fail:  store.appendNotice(`copy failed: ${error}`)
```

### Hint registration

```
setup() → ctx.emit("status:item-update", {
  key: "tui:hint:copy",
  value: "⌃X copy last",
})
  → existing TUI handler updates store
  → StatusBar renders alongside any other status entries
```

## Error handling

- **`renderMarkdown` throws** (malformed input, library bug): wrap in
  try/catch, return the input verbatim. Plain text always renders; worst case
  is the user sees raw markdown.
- **No clipboard CLI and OSC 52 not honored**: `copyToClipboard` returns
  `{ ok: false, via: "none", error }`. `InputBox` posts a notice; nothing
  throws.
- **Subprocess exits non-zero**: captured, attempt OSC 52, surface in notice
  only if both fail.
- **Empty transcript on Ctrl+X**: notice `nothing to copy yet`. Cheap and
  explicit.
- **Concurrent Ctrl+X presses**: each invocation independent; subprocess
  writes serialize at the OS level; user sees two notices. Not coordinated.

## Testing

- `ui/markdown.test.ts` *(new)* — known markdown samples assert expected ANSI
  sequences for headings, lists, code fences; malformed input returns input
  verbatim.
- `clipboard.test.ts` *(new)* — inject fake `spawn`: verify command selection
  per platform, OSC 52 fallback when all subprocesses fail, return-shape
  contracts. No real clipboard touched in tests.
- `state/store.test.ts` — extend with `latestOutputText()` cases: empty
  transcript, mixed kinds, multiple outputs (returns most recent), tool_call
  only (returns `null`).
- `ui/InputBox.test.tsx` — Ctrl+X with no output → notice text. Ctrl+X with
  output → injected clipboard fn receives the right text. Verify Ctrl+X does
  not fall through to typing `x` into the input buffer.
- `integration.test.ts` — push an output entry, simulate Ctrl+X via the
  `InputBox` harness, assert clipboard fn received the source text and a
  success notice landed in the store.
- `index.test.ts` — smoke: on setup, the `status:item-update` event fires with
  `{ key: "tui:hint:copy", value: "⌃X copy last" }`.

## Open questions

None. All five sections approved during brainstorm.

## Out of scope (deferred)

- Theming for the markdown renderer. `marked-terminal` defaults in v1; if the
  rendered output collides with the TUI theme, revisit with explicit
  per-token colors driven by `theme/loader.ts`.
- Custom Ink component tree for markdown (lists with real `<Box>`
  indentation, code-block borders). Reconsider if `marked-terminal`'s
  string-prefix layout looks crummy in practice.
- One-shot-then-suppress behavior for the status hint. Worth adding if
  long-session noise becomes a complaint; not yet.
- Copy targets other than "latest assistant message" (e.g. scroll to pick a
  prior message). Not needed for the user story.
