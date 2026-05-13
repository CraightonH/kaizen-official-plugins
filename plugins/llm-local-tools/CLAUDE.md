# Working in `llm-local-tools`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts          Plugin lifecycle. Resolves tools:registry, registers every entry from ALL_TOOLS,
                  collects unregister fns, and assigns a closure to `plugin._stop` that runs them
                  on `stop()`. The only file that touches `ctx`.
tools.ts          ALL_TOOLS array. Re-exports {schema, handler} from each per-tool module.
                  Add a new tool by appending here.
public.d.ts       Re-exports ToolSchema/ToolCall from llm-contracts/public and the TOOL_NAMES tuple.
util.ts           Pure helpers shared by every tool: resolvePath, truncateBytes, truncateMiddle,
                  sniffBinary, ensureParentExists, hasGitRoot, formatLineNumbered, plus the
                  size-cap constants. No I/O state, no globals beyond constants.
tools/read.ts     Line-numbered file read with offset/limit, binary sniff, 50 MB hard refusal.
tools/write.ts    Overwrite-only writer; refuses if path does not exist.
tools/create.ts   Create-only writer; refuses if path already exists.
tools/edit.ts     Two commands behind one tool. `str_replace` does exact-string replacement (counts
                  occurrences; rejects 0, >1 without replace_all, and no-op edits). `insert` uses
                  1-based AT semantics (`insert_line: N` makes the inserted text the new line N;
                  `1` prepends, `total_lines+1` appends).
tools/glob.ts     Bun.Glob (or fs-walker fallback). mtime-desc sort. .gitignore honored when
                  a .git dir exists at-or-above cwd. Cap 1000.
tools/grep.ts     `rg` shell-out when on PATH (preferred — Rust regex, ripgrep's own gitignore
                  handling, faster); JS fallback otherwise. detectRgPath() probes `which rg` lazily
                  and caches the result. Supports content/files_with_matches/count. Honors
                  ctx.signal — SIGTERMs the rg child on abort.
tools/bash.ts     Spawns via the shell (process group) so SIGTERM/SIGKILL kill children too.
                  Middle-truncation past 256 KB. Wires registry's AbortSignal to SIGTERM.
                  Rejects run_in_background: true.
tools/web_fetch.ts HTTP(S) GET/HEAD via globalThis.fetch (overridable via ctx.fetch).
                  Refuses non-http(s). 30s default timeout, 512 KB in-context body cap.
                  Binary content-types (image/*, audio/*, video/*, application/pdf, octet-stream,
                  archives, office docs, etc.) require `save_to` — otherwise refused so garbage
                  bytes never enter context. `save_to` also works for text (saves + omits body).
                  Downloads capped at WEB_FETCH_DOWNLOAD_CAP_BYTES (50 MB). Honors ctx.signal.
test/             bun:test suites — one per tool, plus util.test.ts, scaffold.test.ts, integration.test.ts.
test/fixtures/    Static inputs used by read/grep/glob tests.
```

Boundaries:

- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- Only the per-tool modules under `tools/` perform I/O. `util.ts` is pure (apart from `existsSync` in `hasGitRoot`).
- `tools.ts` is a flat aggregator — keep it that way. No conditional registration, no env reads here.

## Invariants

- **Path resolution is per-call.** Every handler resolves paths via `resolvePath(p, args.cwd)` at invoke time against `process.cwd()`. There is no plugin-owned working directory. Don't add one.
- **Errors throw native `Error`.** No special error envelope. The registry catches and emits `tool:error`; the active dispatch strategy turns that into a `tool` message. Error messages must include the resolved absolute path when relevant — the LLM uses it to recover.
- **Truncation markers are stable.** The exact `... [truncated: ...]` shape is part of the contract with the LLM (it has been trained on this idiom). Don't reword.
- **Caps live in `util.ts`.** `MAX_READ_BYTES` (50 MB hard refusal), `READ_CAP_BYTES` (256 KB), `READ_CAP_LINES` (2000), `BASH_OUTPUT_CAP` (256 KB), `GREP_DEFAULT_MAX` (200), `GLOB_CAP` (1000), `WEB_FETCH_CAP_BYTES` (512 KB in-context), `WEB_FETCH_DOWNLOAD_CAP_BYTES` (50 MB on disk), `WEB_FETCH_DEFAULT_TIMEOUT_MS` (30 s). Binary content-type classification lives in `isBinaryContentType()` — also in `util.ts`. Tools import them; do not re-declare per-tool defaults.
- **`edit` uniqueness is load-bearing.** Multi-match without `replace_all` MUST throw with the match count. This is the single most important behavioral guarantee — it is what makes `edit` safe for unattended use.
- **`bash` middle-truncates.** Compiler/test output carries signal at both ends. Don't switch to head- or tail-only truncation.
- **`bash` cancellation.** The registry's `ToolExecutionContext.signal` must SIGTERM the spawned process group. `turn:cancel` relies on this.
- **`run_in_background: true` is rejected, not ignored.** Throw a clear error so the LLM doesn't silently lose its long-running job.
- **Ripgrep probe runs once.** `detectRgPath()` is called at module load in `grep.ts`. Don't move it inside the handler — would add a `which` spawn per call.
- **Tag tuples are exact.** `["local", "fs"]` for filesystem tools, `["local", "shell"]` for `bash`, `["local", "web"]` for `web_fetch`. Capability plugins (notably the agents capability) filter on these strings.

## Adding a new tool

1. Create `tools/<name>.ts` exporting `{ schema, handler }`. The schema is a `ToolSchema` (from `llm-contracts/public`); the handler is `(args: any, ctx: any) => Promise<unknown>`.
2. Resolve paths via `resolvePath`. Use the size-cap constants from `util.ts`. Throw native `Error` on failure with informative messages.
3. Tag it: `tags: ["local", "<category>"]`. Reuse `fs` / `shell` if it fits; introduce a new secondary tag only if a capability plugin needs to filter on it.
4. Append `{ schema, handler }` to `ALL_TOOLS` in `tools.ts`.
5. If it changes the published surface, also update `TOOL_NAMES` in `index.ts` and `public.d.ts`.
6. Add `test/tools/<name>.test.ts` with bun:test using `node:fs.mkdtempSync` for isolation.

Use the `bash` tool as the reference for cancellation-aware handlers and the `grep` tool as the reference for "external CLI with a fallback" patterns.

## Testing

```bash
cd plugins/llm-local-tools && bun test
```

Tests use `bun:test` only — no external mocking framework. Each tool test creates its own `mkdtempSync` directory and tears it down in `afterEach`. Static inputs live under `test/fixtures/`.

`scaffold.test.ts` asserts that `ALL_TOOLS` registers every expected name with the right tags — when adding/removing a tool, that test is the contract gate.

## Local deploy

Build from the source directory (where workspace deps resolve), then sync into the install dir:

```bash
PLUGIN=llm-local-tools
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
