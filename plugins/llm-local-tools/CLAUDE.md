# Working in `llm-local-tools`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts          Plugin lifecycle. Resolves tools:registry, registers every entry from ALL_TOOLS,
                  collects unregister fns, returns a teardown that runs them. The only file that touches `ctx`.
tools.ts          ALL_TOOLS array. Re-exports {schema, handler} from each per-tool module.
                  Add a new tool by appending here.
public.d.ts       Re-exports ToolSchema/ToolCall from llm-events/public and the TOOL_NAMES tuple.
util.ts           Pure helpers shared by every tool: resolvePath, truncateBytes, truncateMiddle,
                  sniffBinary, ensureParentExists, hasGitRoot, formatLineNumbered, plus the
                  size-cap constants. No I/O state, no globals beyond constants.
tools/read.ts     Line-numbered file read with offset/limit, binary sniff, 50 MB hard refusal.
tools/write.ts    Overwrite-only writer; refuses if path does not exist.
tools/create.ts   Create-only writer; refuses if path already exists.
tools/edit.ts     Exact-string replacement. Counts occurrences; rejects 0, >1 (without replace_all),
                  and no-op edits.
tools/glob.ts     Bun.Glob (or fs-walker fallback). mtime-desc sort. .gitignore honored when
                  a .git dir exists at-or-above cwd. Cap 1000.
tools/grep.ts     `rg` shell-out when on PATH; JS fallback otherwise. detectRgPath() runs once at
                  module load and caches the result. Supports content/files_with_matches/count.
tools/bash.ts     Spawns via the shell (process group) so SIGTERM/SIGKILL kill children too.
                  Middle-truncation past 256 KB. Wires registry's AbortSignal to SIGTERM.
                  Rejects run_in_background: true.
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
- **Caps live in `util.ts`.** `MAX_READ_BYTES` (50 MB hard refusal), `READ_CAP_BYTES` (256 KB), `READ_CAP_LINES` (2000), `BASH_OUTPUT_CAP` (256 KB), `GREP_DEFAULT_MAX` (200), `GLOB_CAP` (1000). Tools import them; do not re-declare per-tool defaults.
- **`edit` uniqueness is load-bearing.** Multi-match without `replace_all` MUST throw with the match count. This is the single most important behavioral guarantee — it is what makes `edit` safe for unattended use.
- **`bash` middle-truncates.** Compiler/test output carries signal at both ends. Don't switch to head- or tail-only truncation.
- **`bash` cancellation.** The registry's `ToolExecutionContext.signal` must SIGTERM the spawned process group. `turn:cancel` relies on this.
- **`run_in_background: true` is rejected, not ignored.** Throw a clear error so the LLM doesn't silently lose its long-running job.
- **Ripgrep probe runs once.** `detectRgPath()` is called at module load in `grep.ts`. Don't move it inside the handler — would add a `which` spawn per call.
- **Tag tuples are exact.** `["local", "fs"]` for filesystem tools, `["local", "shell"]` for `bash`. Capability plugins (notably the agents capability) filter on these strings.

## Adding a new tool

1. Create `tools/<name>.ts` exporting `{ schema, handler }`. The schema is a `ToolSchema` (re-exported from `llm-events/public`); the handler is `(args: any, ctx: any) => Promise<unknown>`.
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

The Kaizen runtime prefers the bundled `dist/index.js` over source. After editing, the plugin must be re-bundled into the install dir:

```bash
cp -R plugins/llm-local-tools/. ~/.kaizen/marketplaces/official/plugins/llm-local-tools@0.1.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-local-tools@0.1.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
