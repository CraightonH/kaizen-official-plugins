# llm-local-tools

> **Warning — not sandboxed.** This plugin executes whatever shell commands and file writes the LLM emits, with the full privileges of the kaizen process. Do not use it with prompts you did not author, or with LLMs you do not trust to follow instructions. For untrusted contexts, wait for `llm-local-tools-sandboxed` (planned, not yet shipped).

Built-in local-development toolset. Registers a Claude-Code-style surface — `read`, `write`, `create`, `edit`, `glob`, `grep`, `bash`, `web_fetch` — into the shared tools registry so any LLM wired through the harness can drive the local filesystem, run shell commands, and pull HTTP(S) resources.

## What it does

- Registers eight tools at setup; unregisters them all on `stop()`.
- Resolves every path against `process.cwd()` at invocation time (with optional per-call `cwd` overrides on `glob` / `grep` / `bash` / `web_fetch` save). No plugin-managed "current directory" state.
- Tags each tool so capability plugins can include or exclude them by category:
  - `tags: ["local", "fs"]` — `read`, `write`, `create`, `edit`, `glob`, `grep`
  - `tags: ["local", "shell"]` — `bash`
  - `tags: ["local", "web"]` — `web_fetch`
- Mirrors Claude Code semantics where it matters:
  - `read` returns 1-indexed line-numbered output (`cat -n` style), 2000-line / 256 KB caps, refuses files >50 MB, refuses binary files (NUL byte in first 8 KB).
  - `write` overwrites only if the file exists; `create` writes only if it does not. Parent directory must exist for both.
  - `edit` is a two-command tool — `str_replace` (exact-string find/replace, multi-match rejected without `replace_all`) and `insert` (1-based AT semantics, line N becomes the inserted text). Rejects zero-match, ambiguous match, no-op edits, and out-of-range insert lines with self-teaching error messages.
  - `glob` returns absolute paths sorted by mtime descending, capped at 1000; honors `.gitignore` when a `.git` directory exists at or above `cwd`.
  - `grep` shells out to `rg` if on PATH (preferred — Rust regex flavor, fast); otherwise falls back to a JS walker (ECMAScript regex, slower). Supports `content` / `files_with_matches` / `count` output modes.
  - `bash` runs through the shell, combines stdout+stderr in order, default 120 s timeout (hard cap 600 s), middle-truncates output past 256 KB, propagates the registry's `AbortSignal` as SIGTERM, returns a structured `{ exit_code, output, duration_ms, truncated, killed_by_timeout }` result. `run_in_background: true` is reserved in the schema and rejected at runtime.
  - `web_fetch` does HTTP(S) GET/HEAD via `globalThis.fetch` (overridable via `ctx.fetch`). 30 s default timeout (hard cap 120 s), 512 KB in-context body cap. Binary content (image/*, audio/*, video/*, application/pdf, archives, office docs, etc.) requires `save_to` — otherwise refused so garbage bytes never enter context. Downloads capped at 50 MB on disk. Honors `ctx.signal`.
- Emits no events of its own — every invocation runs inside the registry's `invoke`, which already emits the `tool:*` lifecycle.

## Wiring

### Provides

Eight tools registered with the shared `tools:registry` service. Names and tags:

| Name        | Tags             |
|-------------|------------------|
| `read`      | `local`, `fs`    |
| `write`     | `local`, `fs`    |
| `create`    | `local`, `fs`    |
| `edit`      | `local`, `fs`    |
| `glob`      | `local`, `fs`    |
| `grep`      | `local`, `fs`    |
| `bash`      | `local`, `shell` |
| `web_fetch` | `local`, `web`   |

Schemas conform to JSONSchema7 and are written for the LLM (they end up in the `tools` array of the OpenAI request).

Capability plugins compose toolsets via the registry filter API:

```ts
registry.list({ tags: ["fs"] })    // six fs tools
registry.list({ tags: ["shell"] }) // bash only
registry.list({ tags: ["web"] })   // web_fetch only
registry.list({ tags: ["local"] }) // all eight
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
    "offset": { "type": "integer", "minimum": 1 },
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

Two commands behind one tool. Pick by intent — `insert` to add content, `str_replace` to modify or delete existing content.

```jsonc
{ "required": ["command", "path"], "properties": {
    "command":     { "type": "string", "enum": ["str_replace", "insert"] },
    "path":        { "type": "string" },
    "old_str":     { "type": "string" },
    "new_str":     { "type": "string" },
    "replace_all": { "type": "boolean", "default": false },
    "insert_line": { "type": "integer", "minimum": 1 },
    "insert_text": { "type": "string" } } }
```

- **`str_replace`** — finds `old_str` (non-empty, whitespace-sensitive) and replaces with `new_str`. `old_str` MUST appear exactly once unless `replace_all: true`. Rejects zero matches, multi-match without `replace_all`, identical `old_str`/`new_str`. Result: `edited <abs-path>: replaced N occurrence(s)`.
- **`insert`** — places `insert_text` AT line `insert_line` (1-based). For a file with N lines, valid range is `1..N+1`: `1` prepends, `N+1` appends. The inserted text becomes the new line `insert_line`; existing lines shift down. Trailing newlines in `insert_text` are preserved verbatim — the caller decides whether to include one.

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

Probes `rg` once at module load. When ripgrep is present, every call shells out to it (Rust regex syntax, `.gitignore`-aware via ripgrep's defaults). When absent, falls back to a pure-JS walker (ECMAScript regex syntax, ignores `.git` and `node_modules`). Default `max_results` is 200. Regex flavor differs between engines; the description hints at this so the LLM can adapt.

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

### `web_fetch`

```jsonc
{ "required": ["url"], "properties": {
    "url":        { "type": "string" },
    "method":     { "type": "string", "enum": ["GET", "HEAD"], "default": "GET" },
    "headers":    { "type": "object", "additionalProperties": { "type": "string" } },
    "timeout_ms": { "type": "integer", "minimum": 1000, "maximum": 120000 },
    "max_bytes":  { "type": "integer", "minimum": 1024 },
    "save_to":    { "type": "string" },
    "cwd":        { "type": "string" } } }
```

HTTP(S) only; non-http(s) schemes are refused. Follows redirects. Default timeout 30 s (hard cap 120 s). Default in-context body cap 512 KB.

Binary content types — `image/*`, `audio/*`, `video/*`, `font/*`, `application/pdf`, `application/octet-stream`, archive formats (`zip`, `gzip`, `tar`, `xz`, `7z`, `rar`), office documents, executables, `application/wasm` — REQUIRE `save_to`. Without it the call is refused so binary bytes never reach the LLM context. `save_to` works for text too: writes the body to disk and returns metadata only. Downloads capped at 50 MB. Returns:

```jsonc
{ "url": "...", "final_url": "...", "status": 200, "content_type": "text/plain",
  "is_binary": false, "body": "...", "bytes": 0,
  "truncated": false, "redirected": false, "saved_path": null, "duration_ms": 0 }
```

## Configuration

No environment variables. All limits live in `util.ts` as named constants (`MAX_READ_BYTES`, `READ_CAP_BYTES`, `READ_CAP_LINES`, `BASH_OUTPUT_CAP`, `GREP_DEFAULT_MAX`, `GLOB_CAP`, `WEB_FETCH_CAP_BYTES`, `WEB_FETCH_DOWNLOAD_CAP_BYTES`, `WEB_FETCH_DEFAULT_TIMEOUT_MS`).

## Permissions

`tier: trusted` — but functionally unscoped. Touches arbitrary filesystem paths, spawns processes with the kaizen process's privileges, and makes arbitrary HTTP(S) requests. See the warning at the top of this file.
