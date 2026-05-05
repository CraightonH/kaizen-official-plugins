# `llm-local-tools` — Design (Spec 6)

**Status:** draft
**Date:** 2026-04-30
**Scope:** A single plugin that registers a built-in toolset (filesystem + shell) into `tools:registry`. This is the plugin that turns the openai-compatible harness from "a chat client" into "a coding agent." Mirrors Claude Code's familiar tool surface — `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash` — adapted for the openai-compatible context.

Depends on the contracts in [Spec 0 — OpenAI-Compatible Foundation](./2026-04-30-openai-compatible-foundation-design.md). Spec 0 is authoritative; if anything in this document conflicts, Spec 0 wins and this spec is the bug.

## Goal

Provide a complete, batteries-included local-development toolset usable by the LLM as soon as the B-tier harness boots. The user mental model is "Claude Code's tools, but available to whichever local model is wired up." Tools are tagged so capability plugins (notably `llm-agents`) can include or exclude them via `toolFilter`.

## Non-goals

- Sandboxing, jailing, or any non-trivial security boundary. This plugin is explicitly **not** safe to expose to untrusted prompts or untrusted LLMs. A future `llm-local-tools-sandboxed` plugin can replace this one. (See Safety / permissions below.)
- Network-aware tools (HTTP fetch, web search). Out of scope; future plugins.
- A jupyter / notebook tool. Out of scope.
- Background-bash process management as a first-class feature. v0 ships `run_in_background: false` only. (See Open questions.)
- A `TodoWrite`-style state tool. That's a separate capability plugin.
- Editor / IDE integrations.

## Architectural overview

`llm-local-tools` is a leaf plugin. It depends on `llm-tools-registry` (for `tools:registry`) and on the shared types exported by `llm-events`. Its `setup` is one function that, given the registry service, calls `register(schema, handler)` once per tool and returns an unregister bundle.

```
llm-events ──▶ llm-tools-registry ──▶ llm-local-tools
                                    └▶ llm-agents (filters via tags)
```

No event emission of its own — every tool runs inside `ToolsRegistryService.invoke`, which already emits `tool:before-execute` / `tool:execute` / `tool:result` / `tool:error` per Spec 0. Errors are thrown from the handler; the registry converts them to `tool:error`, and the active dispatch strategy converts that into a `tool` chat message so the LLM can react.

Working directory model: every tool resolves paths against `process.cwd()` at the time of invocation, unless an explicit `cwd` argument is supplied. There is no plugin-managed "current directory" state — this matches Claude Code semantics and avoids a footgun.

## Tool surface

All six tools are registered with `tags: ["local", "fs"]` for `read`/`write`/`edit`/`glob`/`grep`, and `tags: ["local", "shell"]` for `bash`. The `local` tag is the broad include/exclude switch; the secondary tag (`fs` / `shell`) lets agents exclude shell while keeping filesystem reads, which is a common pattern.

Schemas below are JSONSchema7. Descriptions are written for the LLM, not the human reader — they are what ends up in the `tools` array of the OpenAI request.

### `read`

Reads a file from disk and returns the contents with `cat -n`-style line numbers, matching Claude Code's `Read` output format. Line-numbered output is what code-editing LLMs expect; it also gives `edit` a stable reference frame for picking unique strings.

```jsonc
{
  "name": "read",
  "description": "Read a file from the local filesystem. Returns contents prefixed with line numbers (1-indexed). Use `offset` and `limit` to page through large files.",
  "parameters": {
    "type": "object",
    "properties": {
      "path":   { "type": "string", "description": "Absolute path, or relative to the process cwd." },
      "offset": { "type": "integer", "minimum": 0, "description": "1-indexed line to start at. Defaults to 1." },
      "limit":  { "type": "integer", "minimum": 1, "description": "Max lines to return. Defaults to 2000." }
    },
    "required": ["path"]
  }
}
```

Behavior:

- Resolve `path` against `process.cwd()`.
- Stream the file line-by-line; do not slurp.
- Default cap **2000 lines** and **256 KB** of returned content. If the file exceeds either, truncate and append a single trailing line: `... [truncated: file has N more lines / M more bytes]`.
- Reject binary files with a clear error (heuristic: presence of NUL byte in first 8 KB). LLMs cannot do anything useful with binary anyway.
- Missing path → throw a `ENOENT` error with the resolved absolute path in the message.
- Refuse to read files larger than 50 MB outright (separate from the truncation cap, this is a guardrail against accidentally reading a database file).

### `write` and `create`

Two tools, deliberately separated. The split is the safer choice and is recommended:

- **`write`** overwrites an existing file. Refuses if the file does not exist.
- **`create`** writes a new file. Refuses if the file already exists.

Rationale for the split (vs. one `write` with a flag):

1. The LLM cannot accidentally clobber a file by forgetting an `overwrite: false` default.
2. The intent is encoded in the tool choice, which makes audit logs and `tool:execute` events self-describing.
3. Mirrors common shell idiom (`>` vs. `>|`) and Claude Code's behavior (Write tool requires Read-first; create-vs-overwrite is an explicit affordance).

The cost is one extra tool in the registry. Acceptable.

```jsonc
{
  "name": "write",
  "description": "Overwrite an existing file with new contents. Fails if the file does not exist; use `create` for new files.",
  "parameters": {
    "type": "object",
    "properties": {
      "path":    { "type": "string" },
      "content": { "type": "string" }
    },
    "required": ["path", "content"]
  }
}
```

```jsonc
{
  "name": "create",
  "description": "Create a new file. Fails if the file already exists; use `write` to overwrite.",
  "parameters": {
    "type": "object",
    "properties": {
      "path":    { "type": "string" },
      "content": { "type": "string" }
    },
    "required": ["path", "content"]
  }
}
```

Behavior (both):

- Parent directory must exist. `create` does **not** mkdir-p — that's a `bash` job. (Open question below.)
- UTF-8, no BOM. Trailing newline behavior follows the input string verbatim.
- Result string: `wrote N bytes to <abs-path>`.

### `edit`

Exact-string replacement, matching Claude Code's `Edit` tool semantics.

```jsonc
{
  "name": "edit",
  "description": "Replace exact text in a file. `old_string` MUST appear exactly once unless `replace_all` is true. Preserve indentation and surrounding context exactly when picking `old_string`.",
  "parameters": {
    "type": "object",
    "properties": {
      "path":        { "type": "string" },
      "old_string":  { "type": "string", "description": "Text to find. Must match exactly, including whitespace." },
      "new_string":  { "type": "string", "description": "Replacement text. Must differ from old_string." },
      "replace_all": { "type": "boolean", "default": false }
    },
    "required": ["path", "old_string", "new_string"]
  }
}
```

Unique-match requirement: with `replace_all: false`, the handler counts occurrences of `old_string` in the file. Zero matches → throw "old_string not found". More than one match → throw "old_string matched N times; supply more context or set replace_all". This is the single most important behavioral contract — it is what makes `edit` safe enough for an LLM to use unattended.

`old_string === new_string` → throw "no-op edit". Caught early to surface LLM mistakes.

Result string: `edited <abs-path>: replaced N occurrence(s)`.

### `glob`

Filesystem path matching by pattern.

```jsonc
{
  "name": "glob",
  "description": "Find files by glob pattern. Returns absolute paths sorted by mtime descending (most recently modified first).",
  "parameters": {
    "type": "object",
    "properties": {
      "pattern": { "type": "string", "description": "Glob pattern, e.g. `**/*.ts` or `src/**/test_*.py`." },
      "cwd":     { "type": "string", "description": "Directory to glob from. Defaults to process cwd." }
    },
    "required": ["pattern"]
  }
}
```

Behavior:

- Implementation: `Bun.Glob` if available, falling back to a tiny Node fs-based walker. No external npm dep.
- Honors `.gitignore` if a `.git` directory is present at or above `cwd` — matches developer expectations and avoids returning `node_modules` paths by default.
- Cap result list at 1000 entries; if exceeded, return the first 1000 with a trailing `... [truncated: M more matches]` marker.

### `grep`

Content search. Wraps `ripgrep` if it is on `PATH`; falls back to a JS implementation otherwise.

```jsonc
{
  "name": "grep",
  "description": "Search file contents for a regex. Wraps ripgrep when available. Returns matching lines with file:line:content.",
  "parameters": {
    "type": "object",
    "properties": {
      "pattern":         { "type": "string", "description": "Regex pattern (Rust regex syntax when ripgrep is used; ECMAScript otherwise)." },
      "path":            { "type": "string", "description": "File or directory to search. Defaults to process cwd." },
      "glob":            { "type": "string", "description": "Restrict to files matching this glob (e.g. `*.ts`)." },
      "case_insensitive":{ "type": "boolean", "default": false },
      "output_mode":     { "type": "string", "enum": ["content", "files_with_matches", "count"], "default": "content" },
      "context":         { "type": "integer", "minimum": 0, "description": "Lines of before/after context (content mode only)." },
      "max_results":     { "type": "integer", "minimum": 1, "description": "Cap on returned matches/files. Default 200." }
    },
    "required": ["pattern"]
  }
}
```

Dependency: ripgrep is a hard runtime preference but a soft dependency. On plugin load, probe `which rg`. Cache the result. If absent, log a one-line warning at startup (`grep: ripgrep not found; using JS fallback (slower)`) and use the fallback. The fallback supports the same arguments but is implemented with `fs.readdir` + JS regex; it is significantly slower on large trees, which is acceptable. Document this in the user-facing README.

The regex-flavor difference between ripgrep (Rust regex, no lookahead/lookbehind) and the JS fallback is documented but not papered over — pattern translation would be a footgun. The tool description tells the LLM which engine is active.

### `bash`

Shell command execution.

```jsonc
{
  "name": "bash",
  "description": "Execute a shell command. Captures combined stdout/stderr. Default timeout 120s. Use sparingly — prefer purpose-built tools when one exists.",
  "parameters": {
    "type": "object",
    "properties": {
      "command":           { "type": "string" },
      "cwd":               { "type": "string", "description": "Working directory. Defaults to process cwd." },
      "timeout":           { "type": "integer", "minimum": 1000, "maximum": 600000, "description": "Milliseconds. Default 120000. Hard max 600000 (10 min)." },
      "run_in_background": { "type": "boolean", "default": false, "description": "Reserved. Currently rejected if true. See bash_output (future)." }
    },
    "required": ["command"]
  }
}
```

Behavior:

- Spawn via `Bun.spawn` (or Node `child_process.spawn` when running under Node) with `shell: true` so the LLM can use pipes, redirection, `&&`, etc. Yes, this is exactly as dangerous as it sounds; see Safety.
- Combine stdout and stderr into a single output stream, preserving order. The LLM cannot reliably reason about two separate streams; one stream with the natural interleaving is more useful.
- Default timeout 120 s, hard cap 600 s. On timeout: send SIGTERM, wait 2 s, send SIGKILL, return the partial output plus a `... [killed: timeout after Nms]` marker and a non-zero `exit_code`.
- Output cap: 256 KB. Excess is truncated from the **middle** (head + tail kept) with a `... [truncated: M bytes elided from middle] ...` marker. Truncating from the middle is correct for typical compiler/test output, where both the start (config / file list) and the end (final error / summary) carry signal.
- The `ToolExecutionContext.signal` from the registry is wired to the spawned process — `turn:cancel` propagates as a SIGTERM.
- Result is a structured object so the LLM can reliably parse exit status:

```jsonc
{
  "exit_code": 0,
  "output": "...",
  "duration_ms": 1234,
  "truncated": false,
  "killed_by_timeout": false
}
```

The dispatch strategy will JSON-stringify this for the `tool` message; the structure is for downstream tools / observers, not the wire format.

`run_in_background: true` is **rejected with a clear error** in v0. See Open questions.

## Cross-cutting concerns

### Safety / permissions — v0 trusts the LLM and the user

This plugin runs every command the LLM emits. There is no path allow-list, no command policy, no `rm -rf` blocker, no network firewall. Rationale:

1. The harness is a **local developer tool**, run on a workstation by an engineer who is reading the TUI. The threat model is "I broke my own checkout," not "an adversary owns my LLM."
2. Defense-in-depth at this layer would be incomplete (a determined LLM can shell-out around any path filter), and a partial defense gives a false sense of security worse than no defense.
3. Spec 0's `tool:before-execute` event is mutable and can be used by any opt-in plugin (e.g. a future `llm-tool-policy`) to layer in command vetting without changing this plugin.

The README MUST contain, in the first 200 words, a bold warning:

> This plugin is **not** sandboxed. It executes whatever shell commands and file writes the LLM emits, with the full privileges of the kaizen process. Do not use it with prompts you did not author, or with LLMs you do not trust to follow instructions. For untrusted contexts, use `llm-local-tools-sandboxed` (planned, not yet shipped).

The `permissions` field in `kaizen.plugin.json` is `unscoped` — touches arbitrary fs paths and spawns processes.

The architecture is structured so a future `llm-local-tools-sandboxed` plugin (Open Container Initiative jail, `bwrap`, or Bun Worker with a vfs shim) can replace this one without any consumer change: same tool names, same schemas, different handlers.

### Working directory

`process.cwd()` resolved at invoke time, with optional per-call `cwd` overrides. No plugin state. If the user runs `cd` inside a `bash` call, the **child** shell sees the change but the parent kaizen process does not — this is correct Unix behavior and matches Claude Code.

### Output size limits

Two distinct caps:

- **Per-tool cap** (return value going back to the LLM): documented per tool above. Defaults: `read` 256 KB / 2000 lines; `bash` 256 KB; `grep` 200 matches; `glob` 1000 paths.
- **Hard refusal threshold** (`read` only): files larger than 50 MB are refused outright before any read. Prevents the LLM from blowing up the process by `read`-ing a sqlite db.

Truncation markers are always a single trailing (or middle) line of the form `... [truncated: <human-readable reason>]`. The LLM has been trained on this idiom; it parses cleanly.

### Tags and registry filtering

Every tool registers with:

- `tags: ["local", "fs"]` — `read`, `write`, `create`, `edit`, `glob`, `grep`
- `tags: ["local", "shell"]` — `bash`

Capability plugins compose:

- `llm-agents` with a "researcher" agent: `toolFilter: { tags: ["fs"] }` (no shell).
- A future `llm-tool-policy` could use `names: [...]` to surgically remove specific tools.

### Error surfacing

Handlers throw native `Error` instances with informative messages. The registry's `invoke` catches them and emits `tool:error`. The active dispatch strategy (Spec 4 / Spec 5) converts that into a `tool` role message containing the error text, so the LLM sees the failure in-band and can adapt. No special error-shape contract needed beyond Spec 0.

### Background bash — deferred

`run_in_background: true` is reserved in the schema but rejected at runtime in v0. Reasons:

1. Process lifetime then has to outlive the turn, which means plugin-owned state and a `bash_output({ id })` companion tool, plus cleanup on `session:end`.
2. Most "background" use cases (`npm run dev`, `tail -f`) are better served by the user running them in another terminal, since the kaizen TUI is the LLM's primary I/O surface.
3. Scope creep risk vs. user value at v0 is bad.

A v1 follow-up spec can add `run_in_background` + `bash_output({ id })` + `bash_kill({ id })` if real users ask for it. Schema reservation now means the addition is non-breaking.

## Implementation notes

For the implementing agent, not normative:

- Pure Node/Bun APIs. Zero external runtime deps. Glob via `Bun.Glob` with a fs-walker fallback. Edit/Read/Write/Create are trivial `fs.promises` calls. Grep shells out to `rg` via `Bun.spawn`; the JS fallback is a plain reader-loop with `RegExp.test`.
- `setup(ctx)` reads the `tools:registry` service, calls `register` six times (or seven, counting `create`), accumulates the unregister functions, and returns a teardown that calls all of them. No event subscriptions; no other side effects at startup beyond the one-line ripgrep probe.
- File layout suggestion: one file per tool under `src/tools/`, each exporting `{ schema, handler }`. `src/index.ts` is the loop that registers all of them.
- Tests use `node:fs.mkdtempSync` for isolated tmp dirs and `Bun.spawn` to assert on bash behavior without mocking the spawn surface.

## Test plan

Per-tool unit tests, all running against tmp dirs created in `beforeEach` and torn down in `afterEach`:

- **`read`**: happy path with line-numbered output; offset/limit; binary refusal (NUL byte); >50 MB refusal (use a sparse file via `truncate`); missing file; default and custom truncation.
- **`write`**: overwrites existing; refuses missing; UTF-8 round-trip; parent-missing failure.
- **`create`**: creates new; refuses existing; parent-missing failure.
- **`edit`**: zero-match rejection; multi-match rejection without `replace_all`; `replace_all: true` replaces all; identical strings rejection; whitespace-sensitive matching.
- **`glob`**: simple `**/*.ts`; `.gitignore` honored when `.git` present and ignored when absent; mtime-descending sort; truncation past 1000.
- **`grep`**: ripgrep path with mocked `which`; JS-fallback path with `which` returning empty; `output_mode` variants; `glob` filter; `context` lines; case-insensitive.
- **`bash`**: stdout/stderr interleaving order preserved; non-zero exit reflected in `exit_code`; timeout fires SIGTERM then SIGKILL and returns partial output; cancel via `signal.abort()`; middle-truncation past 256 KB; `run_in_background: true` rejected.

Cross-cutting:

- Tag filtering: registering all tools then `registry.list({ tags: ["fs"] })` returns five (or six with `create`); `tags: ["shell"]` returns one; `tags: ["local"]` returns all.
- Teardown: returned unregister bundle removes every tool.
- Ripgrep absence is logged once at startup, not per-call.

## Acceptance criteria

- B-tier harness boots with `llm-local-tools` listed, and the registry contains exactly the tools above with the documented schemas and tags.
- Each tool's schema validates as JSONSchema7 (CI check).
- A scripted end-to-end test in the harness:
  1. User prompt: "Create a file `hello.txt` with content `hi`, then read it back, then grep for `hi`."
  2. The LLM produces `create` → `read` → `grep` calls (in some order); each succeeds; the conversation ends with a coherent assistant summary.
- The README starts with the safety warning quoted above.
- A future `llm-local-tools-sandboxed` plugin can be authored against this spec's tool surface without requiring schema changes here.
- Marketplace `entries` updated.

## Open questions

- **Should `create` mkdir-p?** Current spec says no — keeps the surface small and matches `write`. But it forces an LLM to issue a `bash mkdir -p` for a fresh tree. Lean toward adding `parents: true` (default `false`) if early users complain.
- **Should `read` accept globs?** No in v0 — `glob` then iterate is explicit and the LLM does it correctly. Reconsider if patterns of `glob → loop reads` show up in transcripts.
- **`bash` shell choice?** v0 uses the system default shell (`/bin/sh` on Unix, `cmd.exe` on Windows). Should we pin to `bash` explicitly for portability of `&&`/`||` semantics? Likely yes; deferred to implementation.
- **`bash_output` / `bash_kill` follow-up.** When and whether to add the background-process surface. Defer until requested.
- **Telemetry hooks.** Should `read`/`write`/`edit` emit a `status:item-update` (e.g. "edited 3 files this turn")? Probably yes, but that belongs in a separate observability plugin subscribing to `tool:result`, not in this one.
- **Encoding for non-UTF-8 text files.** v0 assumes UTF-8. Latin-1 / UTF-16 source files will be misread. Acceptable for v0; revisit if a real user hits it.
