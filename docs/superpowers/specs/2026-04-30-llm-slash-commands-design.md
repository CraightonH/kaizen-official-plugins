# `llm-slash-commands` — Slash Command Dispatcher (Spec 8)

**Status:** draft
**Date:** 2026-04-30
**Depends on:** Spec 0 (foundation), Spec 2 (`llm-driver`), Spec 7 (`llm-skills`), Spec 9 (`llm-agents`).
**Scope:** A single C-tier plugin that intercepts `input:submit` events, recognizes `/<command>` syntax, and dispatches to a registered command handler. Provides a `slash:registry` service for other plugins to register commands. Loads markdown-based command files from disk. Ships a small set of built-in commands (`/help`, `/clear`, `/model`, `/skills`, `/agents`, `/exit`).

## Goal

Give users a Claude-Code-style slash-command surface inside the openai-compatible harness. Other plugins (skills, agents, memory, MCP-bridge) can contribute commands without taking a hard dependency on this plugin — they register through the `slash:registry` service if it is present and silently no-op if it is not.

## Non-goals

- Tab completion / autocomplete UI. The TUI plugin owns input rendering; this plugin only inspects submitted text.
- Argument schema validation beyond a thin "required vs optional" check. Authors who need rich validation can do it inside their handler.
- Persistent command aliases or user-defined macros beyond the markdown file format described below.
- Streaming output from a slash command back through `llm:token`. Commands either produce a synchronous result, mutate state, or emit a `conversation:user-message` to push their rendered body into the next turn.

## Spec 0 contract additions

This spec introduces a new cross-plugin service. Per Spec 0's propagation rule, the following additions MUST be made to Spec 0 before this plugin is merged:

1. Add the `slash:registry` interface to Spec 0's "Service interfaces" section, owned by `llm-slash-commands`.
2. Add a Changelog entry recording the addition.
3. No event-vocabulary additions are required — `input:submit` and `input:handled` already exist in Spec 0, and `conversation:cleared` is already defined.

The interface to add to Spec 0 verbatim:

```ts
// Owned by `llm-slash-commands`.

export interface SlashCommandContext {
  /** Raw argument string — everything after the command name, with one leading space stripped. */
  args: string;
  /** Original full input line, including the leading slash. */
  raw: string;
  /** Cancellation signal tied to the current turn. */
  signal: AbortSignal;
  /** Emit any harness event. Re-entrant `input:submit` is rejected (see "Re-entrancy"). */
  emit: (event: string, payload: unknown) => Promise<void>;
  /** Convenience: append a system-message line to the transcript without starting a turn. */
  print: (text: string) => Promise<void>;
}

export interface SlashCommandHandler {
  (ctx: SlashCommandContext): Promise<void>;
}

export interface SlashCommandManifest {
  /** Command name without leading slash, lowercase, `[a-z][a-z0-9-]*`. */
  name: string;
  /** One-line description shown by `/help`. */
  description: string;
  /**
   * Free-form usage hint, e.g. `"<model-id>"` or `"[topic]"`.
   * Rendered after the name in `/help` output.
   */
  usage?: string;
  /**
   * Source of the command — used by `/help` to group entries.
   * `"builtin"` for the commands shipped by this plugin,
   * `"plugin"` when registered programmatically by another plugin,
   * `"file"` when loaded from a markdown file under `~/.kaizen-llm/commands/` or `<project>/.kaizen-llm/commands/`.
   */
  source: "builtin" | "plugin" | "file";
  /** Set when `source === "file"`; absolute path to the source markdown. */
  filePath?: string;
}

export interface SlashRegistryService {
  /** Register a programmatic command. Returns an unregister function. Throws on duplicate name. */
  register(manifest: SlashCommandManifest, handler: SlashCommandHandler): () => void;
  /** Look up a command by name (without leading slash). */
  get(name: string): { manifest: SlashCommandManifest; handler: SlashCommandHandler } | undefined;
  /** All commands, sorted by name. */
  list(): SlashCommandManifest[];
}
```

No other Spec 0 sections need to change.

## Architectural overview

The plugin is a passive interceptor with three small subsystems:

1. **Parser.** Pure function `parse(text)` → `{ name, args } | null`. Treats input as a slash command iff it starts with `/`, the next character is `[a-z]`, and the command name (`[a-z0-9-]+`) is in the registry.
2. **Registry.** In-memory `Map<string, { manifest, handler }>`. Backs the `slash:registry` service.
3. **File loader.** Synchronous-ish bootstrap that walks `~/.kaizen-llm/commands/` and `<project>/.kaizen-llm/commands/` once at `start()` time, parses each `*.md` file, and registers a wrapping handler that injects the rendered body into the next turn.

The plugin's `input:submit` subscriber runs at high priority (see "Priority handling"). On a match it dispatches to the handler, then emits `input:handled` with `by: "llm-slash-commands"`. On no match it returns without doing anything — the driver's lower-priority subscriber handles the input as a normal user message.

## Priority handling

Kaizen's event bus supports priorities on `ctx.subscribe(name, handler, { priority })`. Higher priority = earlier delivery. The default priority is `0`. Conventional bands (matching the priority constants exported by `kaizen-core`):

- `100` — interceptor band. Reserved for plugins that may claim an event and short-circuit defaults.
- `0` — default.
- `-100` — observer band. Logging, metrics, telemetry.

This plugin subscribes to `input:submit` at priority `100`. The driver's default `input:submit` handler subscribes at `0` and is required to:

1. Inspect the bus for a prior emission of `input:handled` correlated with the same `input:submit` (matched by an internal monotonic id passed alongside the event, or by a per-event "claimed" flag the bus exposes via `ctx.wasHandled(eventId)` — exact mechanism is owned by `llm-driver` Spec 2 and must be consistent with what this plugin emits).
2. Skip its dispatch if the event was claimed.

Operationally this plugin only needs to:

- Subscribe at priority `100`.
- After successful dispatch, `await ctx.emit("input:handled", { by: "llm-slash-commands" })` *before* returning from the `input:submit` handler.
- On parse miss, return without emitting anything.

If kaizen later exposes an explicit `event.stopPropagation()` style API, this plugin will switch to it; until then `input:handled` is the contract.

## Re-entrancy and loop prevention

A markdown command's body could in principle reference another slash command (`/help`, etc.), and a plugin-registered handler could call `ctx.emit("input:submit", ...)`. Both routes must be blocked to prevent runaway loops.

Rules enforced by this plugin:

1. The `SlashCommandContext.emit` passed to handlers wraps `ctx.emit` and rejects with a typed error if the handler tries to emit `input:submit`. Handlers that need to push synthetic user input MUST emit `conversation:user-message` and call `driver:run-conversation` directly, or use the `print` helper for non-turn-producing output.
2. The plugin maintains a per-async-context flag `inSlashDispatch`. While set, the `input:submit` subscriber returns immediately on any further `input:submit` it sees. (Defense in depth — should not fire if rule 1 holds.)
3. Markdown command bodies are treated as opaque text. A body containing `/foo` is sent verbatim to the LLM; this plugin never re-parses it. The slash prefix only triggers dispatch on raw user input from `input:submit`.

## Argument parsing

Single rule, no flags syntax: **everything after the first space following the command name is the `args` string**, trimmed of one leading space only. The handler is responsible for any further parsing (split on whitespace, parse JSON, treat as freeform prose, etc.).

Examples:

| Input | name | args |
|---|---|---|
| `/help` | `help` | `""` |
| `/help model` | `help` | `"model"` |
| `/model gpt-4o-mini` | `model` | `"gpt-4o-mini"` |
| `/note   hello   world` | `note` | `"  hello   world"` (preserved) |
| `/run {"x":1}` | `run` | `{"x":1}` |

Rejections (treated as not-a-command, falls through to driver):

- Input that does not start with `/`.
- Input where the character after `/` is not `[a-z]` (so `//path` and `/.git` pass through as normal user messages).
- A name that is not in the registry — the plugin emits a `conversation:system-message` of the form `Unknown command: /foo. Type /help for a list.` and `input:handled`. (Choice: better UX than silently sending `/foo` to the LLM.)

## File-based commands

### Discovery

At `start()`:

1. Resolve user dir: `~/.kaizen-llm/commands/`.
2. Resolve project dir: `<cwd>/.kaizen-llm/commands/` (cwd at session start; this plugin does not watch for `cd`-style changes).
3. For each existing dir, glob `*.md` non-recursively.
4. Parse each file. Project-scoped commands shadow user-scoped commands of the same name. Built-ins shadow both — built-ins are registered last but the registry rejects duplicate registration; the loader skips files whose name collides with an already-registered command and emits a single `conversation:system-message` warning at startup listing skipped files.

### File format

```markdown
---
description: One-line summary shown by /help.
usage: "[topic]"
arguments:
  required: false        # optional; defaults to false
---
The body of the command. Anywhere `{{args}}` appears it will be
replaced with the user's argument string. The rendered body is
sent as a `conversation:user-message`, then `driver:run-conversation`
is invoked for one turn.
```

Frontmatter is YAML, parsed with the same library kaizen already vendors (`yaml` package — confirm in implementation, but no new dependency should be introduced).

The substitution token is exactly `{{args}}`, no whitespace tolerance, no escaping syntax. Authors who need a literal `{{args}}` in their prompt currently cannot have one — acceptable trade-off; revisit only if a real use case appears.

If `arguments.required` is `true` and `args` is empty, the handler prints `Command /<name> requires arguments. Usage: /<name> <usage>` and does not start a turn.

### Handler behavior

The wrapping handler that file-based commands get:

1. Validate `args` against `arguments.required`.
2. Render body by string-replacing `{{args}}` (all occurrences).
3. Emit `conversation:user-message` with `{ message: { role: "user", content: rendered } }`.
4. Call `driver:run-conversation` with the conversation's current message history plus the new user message. The driver streams tokens normally.

This makes file-based commands behave exactly like a Claude-Code-style prompt template.

## Built-in commands

| Command | Behavior |
|---|---|
| `/help` | Lists all registered commands grouped by `source` (Built-ins, Plugins, Files). Each line: `/<name>[ <usage>] — <description>`. With `args` non-empty (e.g. `/help model`), prints just that entry plus its `filePath` if it has one. Emits via `ctx.print`; does not start a turn. |
| `/clear` | Emits `conversation:cleared`. The driver subscribes and resets its in-memory message history, token counters, and current `turnId`. Prints `Conversation cleared.`. |
| `/model <name>` | Calls `driver:set-model` on the `DriverService` (see "Driver service additions" below). On unknown model, prints the error returned by the driver. On success, prints `Model set to <name>.`. |
| `/skills` | Calls `skills:registry.list()`. If the service is not present (B-tier harness), prints `Skills plugin not loaded.`. Otherwise prints each manifest as `<name> — <description>` with token estimate if available. |
| `/agents` | Same shape as `/skills` against `agents:registry.list()`. |
| `/exit` | Emits `session:end`. The driver / TUI are responsible for actually terminating the process; this command does not call `process.exit` directly. |

### Driver service additions

`/model` requires the driver to expose a way to mutate the active default model. Add to Spec 2 (driver) — not Spec 0, because this is a single-plugin contract:

```ts
// Extension to DriverService in llm-driver's public.d.ts.
export interface DriverService {
  // ... existing members from Spec 0 ...
  /** Returns the currently selected default model id. */
  getModel(): string;
  /** Sets the default model. Validates against `llm:complete.listModels()`; throws if unknown. */
  setModel(modelId: string): Promise<void>;
}
```

Spec 0 already declares `DriverService`; the addition above lives in Spec 2 and does not require a Spec 0 edit because no other plugin needs `getModel`/`setModel`.

## Plugin lifecycle

```
register() {
  ctx.requireService("llm-events:vocabulary");
  // Optional services — looked up at command-invocation time, not register time:
  //   driver:run-conversation, skills:registry, agents:registry.
}

start() {
  registerBuiltins();                  // /help, /clear, /model, /skills, /agents, /exit
  loadFileCommands();                  // user dir, then project dir
  ctx.provideService("slash:registry", registry);
  ctx.subscribe("input:submit", onInputSubmit, { priority: 100 });
}

stop() {
  // unsubscribes are returned by ctx.subscribe and tracked; called here.
  // file watcher (if added later) torn down here.
}
```

`onInputSubmit` flow:

```
1. parse(text) → null?  return.   // pass-through to driver default handler
2. set inSlashDispatch = true.
3. try { await handler(ctx) } catch (e) { emit("session:error", ...). }
4. finally { inSlashDispatch = false. }
5. await ctx.emit("input:handled", { by: "llm-slash-commands" }).
```

Note: `input:handled` is emitted **after** the handler completes successfully. If a handler throws, the plugin still emits `input:handled` so the driver doesn't double-dispatch a half-processed input. The error is surfaced via `session:error`.

## Permissions

`tier: "trusted"`. Justification:

- Reads from `~/.kaizen-llm/commands/` and `<project>/.kaizen-llm/commands/` (user-controlled directories).
- `/clear` mutates driver conversation state.
- `/model` mutates driver active model.
- `/exit` emits a session-terminating event.

No network access. No arbitrary subprocess execution (markdown bodies are sent to the LLM, not shell-executed).

## Test plan

Unit tests, all isolated with the kaizen test harness:

1. **Parser.**
   - `/help` → `{ name: "help", args: "" }`.
   - `/help foo bar` → `{ name: "help", args: "foo bar" }`.
   - `/note   spaced  ` → preserves internal whitespace, trims one leading space.
   - `hello /foo` → `null`.
   - `//path` → `null`.
   - `/Foo` → `null` (case-sensitive name rule).

2. **Registry.**
   - `register` then `get` round-trips manifest and handler.
   - Duplicate `register` throws.
   - Returned unregister removes the entry; subsequent `get` returns `undefined`.
   - `list` returns sorted manifests.

3. **Built-in handlers.**
   - `/help` with no args lists all registered commands grouped by source.
   - `/help model` prints just the `/model` entry.
   - `/clear` emits exactly one `conversation:cleared` event.
   - `/model gpt-4o` calls `driver.setModel("gpt-4o")` once; on a thrown error from `setModel`, prints the error and does not crash.
   - `/skills` and `/agents` print the expected list when the registry is present, and a clear "not loaded" line when absent.
   - `/exit` emits exactly one `session:end` and does not call `process.exit`.

4. **Dispatch + fall-through.**
   - Submitting `/help` triggers the help handler and emits `input:handled`.
   - Submitting `hello world` triggers no slash handler and emits no `input:handled`.
   - Submitting `/unknown` prints the unknown-command system message and emits `input:handled` (does not fall through).
   - Priority: when both this plugin and a stub low-priority `input:submit` subscriber are attached, the stub observes that `input:handled` was already emitted before its turn (or is otherwise able to detect the claim per the bus mechanism).

5. **File-based commands.**
   - Loading: a fixture dir with `foo.md` containing valid frontmatter + body registers a command named `foo` with `source: "file"` and the correct `filePath`.
   - Project-over-user shadowing: same-named files in both dirs result in the project file winning, with a startup warning.
   - `{{args}}` substitution: invoking `/foo bar baz` produces a `conversation:user-message` whose content has every `{{args}}` replaced with `"bar baz"`.
   - Required-args validation: `arguments.required: true` + empty args prints the usage line and does not call `runConversation`.
   - Malformed frontmatter: file is skipped with a startup warning; no crash.

6. **Re-entrancy.**
   - A handler that calls `ctx.emit("input:submit", { text: "/help" })` causes the wrapped emit to throw a typed `ReentrantSlashEmitError`. The error is surfaced via `session:error` and the original dispatch still emits `input:handled`.
   - Direct re-entry guard: forcibly invoking the `input:submit` subscriber while `inSlashDispatch` is set returns immediately.

7. **`input:handled` emission.**
   - Emitted exactly once per matched dispatch, including the unknown-command path.
   - Not emitted on parse miss.
   - Emitted even when the handler throws.

Integration test (one, in the C-tier harness fixture):

- Boot the C-tier harness with a fixture project dir containing `commands/echo.md` (`{{args}}` body). Drive `input:submit` with `/echo hello`. Assert: a `conversation:user-message` with `content === "hello"` is emitted, the driver runs one turn, and the LLM stub returns a canned response.

## Acceptance criteria

- Plugin builds and passes its own unit tests.
- `slash:registry` interface added to Spec 0 with a Changelog entry, and Spec 0's "Service interfaces" section lists `llm-slash-commands` as the owner.
- `DriverService.getModel`/`setModel` extension added to Spec 2.
- Marketplace `entries` updated for `llm-slash-commands` at `tier: "trusted"`.
- C-tier harness fixture passes the integration test above.
- All built-ins behave per the table in this spec.
- Manual smoke test: in a real C-tier harness session, `/help`, `/clear`, `/model`, `/skills`, `/agents`, and a project-local file-based command all behave as documented.

## Open questions

- **Bus-level claim mechanism.** This spec assumes `input:handled` is the contract because Spec 0 already lists the event. If `llm-driver` (Spec 2) prefers a different mechanism (e.g. `ctx.subscribe` returning a "handled" sentinel), this plugin will follow — Spec 2 owns the choice and this plugin updates accordingly.
- **File watcher.** Currently a one-shot scan at startup. Live reload of edited markdown files is deferred; if added it lives behind a config flag and uses `fs.watch` with debouncing.
- **Per-command permissions.** All commands run with the plugin's `trusted` tier. If a future command needs untrusted execution (e.g. shell-out from a markdown body), it requires its own plugin.
