# Claude Code wrapper — kaizen plugin ecosystem (v1)

**Date:** 2026-04-27
**Target kaizen version:** 0.3.0 (`PLUGIN_API_VERSION = "3"`)
**Status:** design approved, awaiting user review

## Goal

Replace the existing minimum-shell example plugins with a real ecosystem: a Claude Code wrapper that presents a distinctive prompt + extensible status bar in the terminal, and forwards prompts to the locally-installed `claude` CLI in headless mode.

The user has a Claude Pro/Max subscription. The wrapper invokes the official `claude` binary (which uses the user's existing OAuth login). It does **not** embed the Agent SDK, because per [Anthropic's authentication policy](https://code.claude.com/docs/en/legal-and-compliance), Pro/Max OAuth tokens are restricted to "Claude Code and other native Anthropic applications" — not third-party tools using the SDK directly.

## Non-goals (v1)

- Multi-turn persistent `claude` subprocess via `--input-format stream-json`. The protocol is undocumented and has open hang bugs ([#3187](https://github.com/anthropics/claude-code/issues/3187), [#25629](https://github.com/anthropics/claude-code/issues/25629)). Per-turn one-shot is reliable and cheap enough.
- Embedding the Agent SDK (`@anthropic-ai/claude-agent-sdk`).
- Token usage as percent of context window. Display raw counts only.
- Slash commands beyond `/exit` and `/clear`.
- Configurable status-item ordering / hide-list / themes.
- Tool-call approval UI (claude already prints its own).
- Web UI. Designed for, not built.
- Splitting agent IPC out of the driver. Future task; the driver currently *is* the claude wrapper.

## Plugin lineup

| Plugin | Driver | Tier | Provides | Consumes | Responsibility |
|---|---|---|---|---|---|
| `claude-events` | – | trusted | `claude-events:vocabulary` | – | Defines event names. Pure vocab plugin per the canonical pattern in [ecosystem-design.md](../../../../../kaizen/docs/guides/ecosystem-design.md). |
| `claude-driver` | ✓ | unscoped | – | `claude-events:vocabulary`, `ui:channel` | Owns the session loop. Spawns `claude -p <prompt> --continue --output-format stream-json --verbose --include-partial-messages` per turn. Parses the event stream, fans out to `ui:channel` and `status:item-update` events. Subscribes to `turn:cancel` to SIGINT the active child. |
| `claude-tui` | – | unscoped | `ui:channel` | `claude-events:vocabulary` | Renders the prompt (rounded box with "kaizen" title) + status row in the terminal. Reads stdin, returns lines via `ui:channel.readInput()`. Subscribes to `status:item-update` / `status:item-clear` to repaint the bar. Emits `turn:cancel` on Ctrl-C during a busy turn. Owns slash commands `/exit` and `/clear`. |
| `claude-status-items` | – | scoped (`exec: ["git"]`) | – | `claude-events:vocabulary` | Emits `cwd` and `git.branch` items on `session:start`. Drop-in/drop-out without anyone else noticing. |

`claude-driver` and `claude-tui` are `unscoped` because they need direct `process.stdin` / `process.stdout` and `child_process.spawn`. This matches the existing 0.2.0 `shell` plugin's tier choice.

## Service: `ui:channel`

Provided by `claude-tui`. Replaceable wholesale by a future `web-ui` plugin without touching the driver.

```ts
// claude-tui/public.d.ts
export interface UiChannel {
  readInput(): Promise<string>;                           // resolves on Enter; "" on EOF/Ctrl-D
  writeOutput(chunk: string): void;                       // streamed assistant text, prints as-is
  writeNotice(line: string): void;                        // out-of-band info, e.g. session-resumed
  setBusy(busy: boolean, message?: string): void;         // spinner during turn; message is purely cosmetic
}
```

The status bar is *not* part of `ui:channel`. UIs render their own bar from the `status:item-update` event stream. The wire-level extensibility contract is the events, not the service.

## Events

Defined by `claude-events`. Plugins that emit any of these declare `consumes: ["claude-events:vocabulary"]` to pin init order through the topo-sort (per [ecosystem-design.md § Init order](../../../../../kaizen/docs/guides/ecosystem-design.md#init-order-and-the-vocabulary-pattern)).

| Name | Payload | Emitted by | Subscribed by |
|---|---|---|---|
| `session:start` | `{}` | `claude-driver` | `claude-tui`, `claude-status-items` |
| `session:end` | `{}` | `claude-driver` | `claude-tui`, `claude-status-items` |
| `session:error` | `{ message: string }` | `claude-driver` | `claude-tui` |
| `turn:before` | `{ prompt: string }` | `claude-driver` | – (open hook for v2 policy plugins) |
| `turn:after` | `{ tokensIn: number; tokensOut: number; cacheReadTokens?: number; cacheCreationTokens?: number; durationMs: number }` | `claude-driver` | `claude-driver`'s own status emitter |
| `turn:cancel` | `{}` | `claude-tui` (and any other plugin) | `claude-driver` |
| `status:item-update` | `{ id: string; content: string; priority?: number; ttlMs?: number }` | anyone | `claude-tui` |
| `status:item-clear` | `{ id: string }` | anyone | `claude-tui` |

### Status item conventions

- `id` is a stable string the emitter owns. Re-emitting with the same `id` replaces the prior value.
- `priority` is left-to-right ordering (lower first). Defaults: `llm.model`=10, `llm.context`=20, `cwd`=80, `git.branch`=90.
- `ttlMs` lets transient items auto-expire (none in v1; design hook).
- v1 IDs:
  - `llm.model` — owned by `claude-driver`. Content example: `opus-4.7`.
  - `llm.context` — owned by `claude-driver`. Content example: `84k in · 12k out`.
  - `cwd` — owned by `claude-status-items`. Basename of `process.cwd()`.
  - `git.branch` — owned by `claude-status-items`. Output of `git rev-parse --abbrev-ref HEAD`, or omitted if not a git repo.

The `llm.*` namespace (not `claude.*`) keeps these reusable when a future `gemini-driver` / `codex-driver` ships.

## Visual design

```
╭─ kaizen ────────────────────────────────────────────────────────────╮
│ ❯                                                                   │
╰─────────────────────────────────────────────────────────────────────╯
 opus-4.7 · 84k in · 12k out · ~/git/kaizen-official-plugins · main
```

- Rounded Unicode box (`╭ ╮ ╰ ╯ ─ │`).
- "kaizen" baked into the top border.
- Status row immediately below the box, unboxed, dot-separated.
- During a turn, the prompt placeholder is replaced by `setBusy(true, "thinking…")` content, e.g. `⠙ thinking…` (spinner cycling).
- Output streams above the box and pushes the box down. After the turn, the prompt re-renders.

## Per-turn data flow

1. `claude-driver.start()` calls `ctx.useService<UiChannel>("ui:channel")`, emits `session:start`.
2. Loop:
   1. `await ui.readInput()` — blocks until user hits Enter.
   2. If the line equals `""` (EOF), emit `session:end` and return.
   3. If the line is a slash command, `claude-tui` handles it and `readInput` returns the next line. (Driver never sees `/exit` etc.)
   4. `ui.setBusy(true, <random message>)`. Driver emits `turn:before {prompt}`.
   5. Driver spawns `claude -p <prompt> --output-format stream-json --verbose --include-partial-messages` (with `--continue` on every turn after the first). Stdin closed.
   6. Reads child stdout line-by-line as newline-delimited JSON:
      - `system/init` → emit `status:item-update {id:"llm.model", content:<model>, priority:10}`.
      - `stream_event` with `event.delta.type === "text_delta"` → `ui.writeOutput(event.delta.text)`.
      - `system/api_retry` → `ui.writeNotice(<retry summary>)`.
      - `result` → capture `session_id`, total tokens, duration; emit `status:item-update {id:"llm.context", content:"<in>k in · <out>k out", priority:20}`; emit `turn:after`.
      - Any malformed line → `ctx.log("dropped malformed stream-json: <line>")`, continue.
   7. After `result`: arm a 2s grace timer; if the child is still alive, SIGTERM; another 2s, SIGKILL. (Workaround for [#25629](https://github.com/anthropics/claude-code/issues/25629).)
   8. Driver emits `turn:after`; `ui.setBusy(false)`.
3. On `turn:cancel`: SIGINT the child if any; `ui.writeNotice("↯ cancelled")`; loop back to `readInput`.

### First turn vs subsequent

Driver tracks whether it has a `session_id` from a prior `result`. First turn omits `--continue`; later turns include it. Capturing `session_id` also lets future plugins resume specific sessions via `--resume <id>`.

## Error handling

| Failure | Behavior |
|---|---|
| `claude` not on PATH | `ui.writeNotice("claude not found — install Claude Code first")`. Emit `session:end`. Process exits non-zero. |
| `claude` exits non-zero mid-turn | Collect stderr. Emit `session:error {message}`. UI prints red. Drop the captured `session_id` so next turn omits `--continue` (start fresh). |
| Stream-json parse error | Drop the line, log, continue. |
| Hung child after `result` | 2s grace → SIGTERM → 2s grace → SIGKILL. |
| Ctrl-C during turn | `claude-tui` emits `turn:cancel`. Driver SIGINTs child. |
| Ctrl-D / EOF on input | `readInput()` resolves `""` → driver emits `session:end`, returns. Kaizen tears down. |
| Missing `ui:channel` provider | Kaizen's startup topo-sort fails fast — driver `consumes` it. Clear error. |

## Permissions

- `claude-events`: trusted (no I/O).
- `claude-driver`: unscoped — needs `child_process.spawn`, `process.stdin`/`stdout` for streaming. Same rationale as the existing `shell` plugin.
- `claude-tui`: unscoped — raw stdin/stdout, terminal control codes, possibly `readline`.
- `claude-status-items`: scoped, `exec: { binaries: ["git"] }`. Reads `process.cwd()` directly (allowed; only `ctx.fs` and `ctx.exec` are gated, not `process.cwd()` itself per [host-api.md](../../../../../kaizen/docs/reference/host-api.md)). **TODO during implementation:** verify `process.cwd()` access on scoped tier; if not, escalate to unscoped.

## Testing

Per [plugin-standards.md](../../../../../kaizen/docs/reference/plugin-standards.md), each plugin ships ≥1 `*.test.ts` exercising metadata + `setup()`.

- **`claude-events`** — assert all event names defined and vocab provided.
- **`claude-tui`** — stub `process.stdin` with a fake readable; drive `readInput()` end-to-end; assert returned line. Snapshot writes during a `setBusy(true, "thinking…")` cycle. Test slash-command short-circuit (`/exit`).
- **`claude-driver`** —
  - Stub `child_process.spawn` to emit canned NDJSON: `system/init` → 3× `text_delta` → `result`. Assert: `session:start` emitted; `writeOutput` called 3× with deltas; `status:item-update` for `llm.model` and `llm.context`; `turn:after` emitted.
  - Malformed JSON line → handler logs, continues, turn completes.
  - Child still alive 2s after `result` → SIGTERM sent.
  - `turn:cancel` mid-turn → SIGINT sent to child.
- **`claude-status-items`** — stub `ctx.exec.run("git", ["rev-parse", "--abbrev-ref", "HEAD"])` → `"main\n"`. Assert `status:item-update {id:"git.branch", content:"main"}` on `session:start`.

## Marketplace + harness changes

### Delete

- `plugins/events/`
- `plugins/shell/`
- `plugins/driver/`
- `harnesses/minimum-shell.json`
- Their entries from `.kaizen/marketplace.json`.

### Add

- `plugins/claude-events/`
- `plugins/claude-driver/`
- `plugins/claude-tui/`
- `plugins/claude-status-items/`
- `harnesses/claude-wrapper.json`:
  ```json
  {
    "plugins": [
      "official/claude-events@0.1.0",
      "official/claude-tui@0.1.0",
      "official/claude-status-items@0.1.0",
      "official/claude-driver@0.1.0"
    ]
  }
  ```
- Catalog entries for the four plugins (kind: plugin) and the harness (kind: harness) in `.kaizen/marketplace.json`. All `apiVersion: "3.0.0"`, version `0.1.0`.

## Documentation gaps to file against kaizen

While walking the docs, the following gaps were noticed. Will file as issues against the kaizen repo before implementation starts:

1. **Stdin reading in `apiVersion` 3.** The existing 0.2.0 `driver` plugin imports `readStdinLine` from `kaizen/types` — but [host-api.md](../../../../../kaizen/docs/reference/host-api.md) explicitly says the only runtime export of `kaizen/types` is `PLUGIN_API_VERSION`. Either the helper still exists and isn't documented, or it was removed and the plugin is broken. Either way, plugin authors writing input-reading drivers have no documented path forward. Need an explicit "how to read stdin from a driver" section.

2. **`process.cwd()` on `scoped` tier.** Reference docs are ambiguous about which Node globals are filtered for non-`unscoped` plugins. The plugin-authoring guide enumerates banned imports (`node:fs`, etc.) but doesn't say what `process` globals (cwd, env, kill signals) are permitted on scoped. Adding a "what's available without grants" table would close the gap.

3. **`apiVersion` example mismatch.** The plugin-authoring guide example shows `apiVersion: "3.0.0"`, the existing official plugins ship `"2.0.0"`, and `PLUGIN_API_VERSION` is `"3"`. Recommended explicit guidance on the apiVersion-vs-PLUGIN_API_VERSION format relationship would prevent confusion. (Is `"3"`, `"3.0.0"`, `"3.0"` all OK? Validator is documented to accept "semver" — `"3"` isn't semver.)

These don't block v1; the implementation will use the existing patterns (and unscoped tier where uncertain) until the docs land.

## File layout (per plugin)

Per [plugin-authoring.md § Scaffold](../../../../../kaizen/docs/guides/plugin-authoring.md#scaffold), each plugin is generated by `kaizen plugin create` and produces:

```
plugins/<name>/
  package.json            # type:module, exports["."], keywords:["kaizen-plugin"]
  tsconfig.json
  index.ts                # default export = KaizenPlugin
  public.d.ts             # only for plugins that provide services (claude-tui, claude-events)
  index.test.ts
  README.md
  .kaizen/.gitkeep
```

## Open questions deferred to implementation

- Spinner library / character set for `setBusy` — pick during implementation.
- Whether `claude-tui` uses Node's built-in `readline` or raw stdin parsing — implementation detail.
- Random "cutesy" busy messages — small static array in `claude-driver`, picks one per turn.
- Bar truncation strategy when `process.stdout.columns` is small — implementation detail.

## Approval

Locked through brainstorming on 2026-04-27:

- Plugin lineup (4 plugins, namespaced `claude-*`).
- IPC strategy: per-turn `claude -p --continue --output-format stream-json …`.
- `ui:channel` shape (4 methods, `setBusy` takes optional message).
- Event vocabulary (8 events, `llm.*` not `claude.*` for status items).
- Visual: rounded box with "kaizen" title (option B from mockups).
- Cancellation as `turn:cancel` event.
- Old plugins/harness deleted, not migrated.
