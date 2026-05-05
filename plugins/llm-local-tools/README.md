# llm-local-tools

> **Warning — not sandboxed.** This plugin executes whatever shell commands and file writes the LLM emits, with the full privileges of the kaizen process. Do not use it with prompts you did not author, or with LLMs you do not trust to follow instructions. For untrusted contexts, wait for `llm-local-tools-sandboxed` (planned, not yet shipped).

Built-in local-development toolset. Registers a Claude-Code-style surface — `read`, `write`, `create`, `edit`, `glob`, `grep`, `bash` — into the shared tools registry so any LLM wired through the harness can drive the local filesystem and shell.

## What it does

- Registers seven tools at setup; unregisters them all on teardown.
- Resolves every path against `process.cwd()` at invocation time (with optional per-call `cwd` overrides on `glob` / `grep` / `bash`). No plugin-managed "current directory" state.
- Tags each tool so capability plugins can include or exclude them by category:
  - `tags: ["local", "fs"]` — `read`, `write`, `create`, `edit`, `glob`, `grep`
  - `tags: ["local", "shell"]` — `bash`
- Mirrors Claude Code semantics where it matters:
  - `read` returns 1-indexed line-numbered output (`cat -n` style), 2000-line / 256 KB caps, refuses files >50 MB, refuses binary files (NUL byte in first 8 KB).
  - `write` overwrites only if the file exists; `create` writes only if it does not. Parent directory must exist for both.
  - `edit` does exact-string replacement; rejects zero-match, multi-match (without `replace_all`), and no-op edits.
  - `glob` returns absolute paths sorted by mtime descending, capped at 1000; honors `.gitignore` when a `.git` directory exists at or above `cwd`.
  - `grep` shells out to `rg` if on PATH, otherwise a JS fallback (slower; ECMAScript regex instead of Rust regex). Supports `content` / `files_with_matches` / `count` output modes.
  - `bash` runs through the shell, combines stdout+stderr in order, default 120 s timeout (hard cap 600 s), middle-truncates output past 256 KB, propagates the registry's `AbortSignal` as SIGTERM, returns a structured `{ exit_code, output, duration_ms, truncated, killed_by_timeout }` result. `run_in_background: true` is reserved in the schema and rejected at runtime.
- Emits no events of its own — every invocation runs inside the registry's `invoke`, which already emits the `tool:*` lifecycle.

## Wiring

### Provides

Seven tools registered with the shared `tools:registry` service. Names and tags:

| Name     | Tags             |
|----------|------------------|
| `read`   | `local`, `fs`    |
| `write`  | `local`, `fs`    |
| `create` | `local`, `fs`    |
| `edit`   | `local`, `fs`    |
| `glob`   | `local`, `fs`    |
| `grep`   | `local`, `fs`    |
| `bash`   | `local`, `shell` |

Schemas conform to JSONSchema7 and are written for the LLM (they end up in the `tools` array of the OpenAI request).

Capability plugins compose toolsets via the registry filter API:

```ts
registry.list({ tags: ["fs"] })    // six tools, no shell
registry.list({ tags: ["shell"] }) // bash only
registry.list({ tags: ["local"] }) // all seven
```

### Consumes

**Service** — `tools:registry` (required). Used to `register(schema, handler)` each tool. If the service is unavailable at setup, the plugin throws.

**VOCAB** — `llm-events:vocabulary` (declared as a consumed service so the plugin loads after the events vocabulary is published). Tool result/error shaping is owned by the registry and the active dispatch strategy; this plugin only throws native `Error`s on failure and the registry surfaces them as `tool:error`.

### Events emitted

None directly. Every invocation flows through the registry's `tool:before-execute` / `tool:execute` / `tool:result` / `tool:error` lifecycle.

## Behavior reference

### `read`

```jsonc
{ "name": "read",
  "parameters": { "required": ["path"], "properties": {
    "path":   { "type": "string" },
    "offset": { "type": "integer", "minimum": 0 },
    "limit":  { "type": "integer", "minimum": 1 } } } }
```

Streams the file line-by-line. Returns 1-indexed line-numbered output. Defaults: `offset` 1, `limit` 2000. Caps: 2000 lines and 256 KB; truncation marker `... [truncated: ...]`. Refuses binary (NUL byte in first 8 KB) and files >50 MB. Missing path → `ENOENT` with the absolute path in the message.

### `write` / `create`

```jsonc
{ "required": ["path", "content"], "properties": {
    "path":    { "type": "string" },
    "content": { "type": "string" } } }
```

`write` overwrites; refuses if the file does not exist. `create` writes new; refuses if the file exists. Neither does mkdir-p — parent directory must exist. UTF-8, no BOM. Result: `wrote N bytes to <abs-path>`.

### `edit`

```jsonc
{ "required": ["path", "old_string", "new_string"], "properties": {
    "path":        { "type": "string" },
    "old_string":  { "type": "string" },
    "new_string":  { "type": "string" },
    "replace_all": { "type": "boolean", "default": false } } }
```

Counts occurrences of `old_string`. Zero → throws "old_string not found". More than one with `replace_all: false` → throws with the count and a hint. `old_string === new_string` → throws "no-op edit". Result: `edited <abs-path>: replaced N occurrence(s)`.

### `glob`

```jsonc
{ "required": ["pattern"], "properties": {
    "pattern": { "type": "string" },
    "cwd":     { "type": "string" } } }
```

Returns absolute paths, mtime-descending. Honors `.gitignore` if a `.git` directory exists at or above `cwd`. Capped at 1000.

### `grep`

```jsonc
{ "required": ["pattern"], "properties": {
    "pattern":          { "type": "string" },
    "path":             { "type": "string" },
    "glob":             { "type": "string" },
    "case_insensitive": { "type": "boolean", "default": false },
    "output_mode":      { "type": "string", "enum": ["content", "files_with_matches", "count"], "default": "content" },
    "context":          { "type": "integer", "minimum": 0 },
    "max_results":      { "type": "integer", "minimum": 1 } } }
```

Probes `rg` once at module load; uses ripgrep when present, JS fallback otherwise. Default `max_results` is 200. Regex flavor differs between engines (Rust regex vs. ECMAScript); the description notes this so the LLM can adapt.

### `bash`

```jsonc
{ "required": ["command"], "properties": {
    "command":           { "type": "string" },
    "cwd":               { "type": "string" },
    "timeout":           { "type": "integer", "minimum": 1000, "maximum": 600000 },
    "run_in_background": { "type": "boolean", "default": false } } }
```

Spawns through the shell so pipes / `&&` / redirection work. Combined stdout+stderr in order. Default timeout 120000 ms; on timeout sends SIGTERM, waits 2 s, then SIGKILL. Output cap 256 KB, truncated from the **middle** (head + tail kept). Returns:

```jsonc
{ "exit_code": 0, "output": "...", "duration_ms": 0, "truncated": false, "killed_by_timeout": false }
```

`run_in_background: true` is rejected — schema reserves the field for a future bash_output / bash_kill follow-up.

## Configuration

No environment variables. All limits live in `util.ts` as named constants (`MAX_READ_BYTES`, `READ_CAP_BYTES`, `READ_CAP_LINES`, `BASH_OUTPUT_CAP`, `GREP_DEFAULT_MAX`, `GLOB_CAP`).

## Permissions

`tier: trusted` — but functionally unscoped. Touches arbitrary filesystem paths and spawns processes with the kaizen process's privileges. See the warning at the top of this file.
