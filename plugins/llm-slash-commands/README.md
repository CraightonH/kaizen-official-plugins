# llm-slash-commands

Owns slash-command intake for the harness. Intercepts user input that begins with `/<name>`, dispatches to a registered handler, and exposes a registry so other plugins can contribute commands.

## What it does

- Parses `/<name>[ args]` from `input:submit` payloads. Per-segment name shape `[a-z][a-z0-9-]*`, colon-separated for namespacing (`mcp:my-server:my-prompt`).
- Maintains an in-memory command registry: `{ manifest, handler }` keyed by name.
- Loads markdown command files from disk at setup:
  - **User:** `~/.kaizen/commands/*.md`
  - **Project:** `<cwd>/.kaizen/commands/*.md`
  - YAML frontmatter (`description`, optional `usage`, optional `arguments.required`); body supports `{{args}}` substitution. Project files shadow user files of the same name.
- Ships built-ins:
  - `/help [command]` — list all registered commands grouped by source (Built-in, Driver, Skills, Agents, Sessions, Memory, MCP, User), or print one entry's detail.
  - `/exit` — request harness shutdown via `harness:exit-requested`.
  - `/history` — enter the TUI audit/history view via `tui:enter-history`.
- Session-management commands (`/clear`, `/session:*`) are owned by `llm-session-manager`, not this plugin. They register against `slash:registry` like any other plugin contributor.
- On parse miss, returns silently so the lower-priority default `input:submit` consumer can treat the line as a normal user message.
- On unknown command, prints `Unknown command: /foo. Type /help for a list.` and claims the event.
- Optionally registers a `/`-triggered completion source against `ui:completion-source` if that service is present.

## Wiring

### Provides

**Service** — `slash:registry`

```typescript
interface SlashCommandManifest {
  name: string;                              // [a-z][a-z0-9-]* per :-segment
  description: string;
  usage?: string;
  source: "builtin" | "plugin" | "file";
  filePath?: string;                          // set when source === "file"
}

interface SlashCommandContext {
  args: string;                               // raw arg string, one leading space stripped
  raw: string;                                // full input line incl. "/"
  signal: AbortSignal;                        // session/turn cancel
  emit: (event: string, payload: unknown) => Promise<void>;  // rejects re-entrant input:submit
  print: (text: string) => Promise<void>;     // emit conversation:system-message
}

interface SlashRegistryService {
  register(manifest: SlashCommandManifest, handler: SlashCommandHandler): () => void;
  get(name: string): { manifest: SlashCommandManifest; handler: SlashCommandHandler } | undefined;
  list(): SlashCommandManifest[];             // sorted by name
}
```

Semantics:
- `register()` returns an unregister function. Re-registering the same `name` while live throws `DuplicateRegistrationError`.
- `register()` enforces namespacing: `source: "plugin"` with a bare name (no `:`) throws `BareNamePluginError`. Bare names are reserved for `source: "builtin"` and `source: "file"`.
- Invalid name shape throws `InvalidNameError`.
- `get()` returns `undefined` for unknown names (case-sensitive).

### Consumes

All consumed services are optional — there is no hard `services.consumes` edge. Plugins that need slash commands declare a hard `consumes: ["slash:registry"]` against this plugin; this plugin itself degrades cleanly when peers are absent.

**Service** — `driver:run-conversation` (optional). Looked up at command-invocation time. File-based commands invoke `runConversation()` against the active session in lieu of emitting `conversation:user-message`. If the driver or active session is absent, the rendered body is emitted as `conversation:user-message` instead and the turn is skipped.

**Service** — `ui:completion-source` (optional). When present, the plugin registers one source with `trigger: "/"` that filters `registry.list()` against the prefix and ranks built-ins first, then file-sourced, then plugin-namespaced. When absent, dispatch via `input:submit` works unchanged.

### Events observed

- `session:active-changed` — tracks the active session id for file-command dispatch into `driver:run-conversation`.
- `harness:start` — deferred lookup of `ui:completion-source`.

### Events

Subscribes:
- `input:submit` at priority `100`. On match: dispatches the handler, then emits `input:handled`. On parse miss: returns without emitting.

Emits:
- `input:handled` — `{ by: "llm-slash-commands" }`. Emitted after every claimed dispatch (matched, unknown-command, or handler-threw).
- `conversation:system-message` — used by `print()`, by the unknown-command path, and by file-loader startup warnings.
- `conversation:user-message` — emitted by file-based command handlers when `driver:run-conversation` or the active session is absent.
- `harness:error` — when a handler throws. The original dispatch still emits `input:handled`.
- `harness:exit-requested` — emitted by `/exit`.
- `tui:enter-history` — emitted by `/history`. Owned by `llm-tui`.

The wrapped `emit` passed to handlers throws `ReentrantSlashEmitError` if a handler attempts to re-emit `input:submit`. A per-dispatch flag also drops any nested `input:submit` the subscriber sees as defense in depth.

## Configuration

| Var | Effect |
|-----|--------|
| `HOME` | Base for the user command dir (`$HOME/.kaizen/commands/`). |

The project command dir is derived from `process.cwd()` at setup time; no env override.

## Permissions

`tier: unscoped` — reads two user-controlled directories (`~/.kaizen/commands/`, `<cwd>/.kaizen/commands/`); emits a harness-shutdown event on `/exit`. No network or subprocess.
