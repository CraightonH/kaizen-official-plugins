# Working in `llm-codemode`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## What this plugin is (and is not)

This plugin registers exactly one tool, `execute_typescript`, with `tools:registry`. It does NOT provide `dispatch:strategy`. The dispatch strategy is `llm-native-dispatch`; this plugin is just a tool implementer that happens to spawn a Bun Worker sandbox in its handler.

## Module map

```
index.ts            Plugin lifecycle. Loads config from config:store (topo-hint
                    optional, falls back to DEFAULT_CONFIG), renders the
                    kaizen.tools .d.ts from the live registry, registers
                    `execute_typescript` with the registry. The only file that
                    touches `ctx`. Does NOT register a TUI renderer — that lives
                    in `llm-tui/tool-renderers/defaults.tsx` (see "No React/Ink"
                    note below).
config.ts           DEFAULT_CONFIG (frozen) + CONFIG_SCHEMA for config:store.
sandbox-host.ts     runInSandbox(...). Spawns Worker, owns message loop, enforces
                    timeout, aggregates stdout, bridges tool RPC. Emits
                    `tool:progress` with stdout deltas when an outerCallId is
                    provided (i.e. when invoked from the tool handler).
sandbox-entry.ts    Worker entrypoint. Builds the `kaizen` proxy and runs user code.
wrapper.ts          wrapCode(userCode) → { wrapped, transpileError? }.
dts-render.ts       renderDts(tools) → string. Used to build the tool description.
serialize.ts        formatToolResult(...) → string. Produces the `tool` role
                    message content. NOTE: no `[code execution result]` prefix —
                    the role label is the signal.
assembler.ts        renderSurface / surfaceHash helpers used to build the
                    rendered .d.ts surface in the tool description. Drives
                    grouping through bucketFor() (re-exports normalizeServerName
                    for tests + sandbox-host backcompat).
buckets.ts          Codemode-owned presentation policy. Maps the open
                    ToolSource from llm-tools-registry into the closed set of
                    kaizen namespaces (tools, mcp, agents, skills, memory).
                    Unknown source kinds fall through to the `tools` bucket.
                    Loaded both from the host and from the sandbox worker —
                    keep runtime-dependency-free.
kaizen-tree.ts      Shared grouping helper. Turns a flat list of
                    `{ name, source }` into the nested
                    `kaizen.{tools,mcp,agents,skills,memory}` tree, with the
                    leaf type chosen by the caller. Used by both
                    `sandbox-host.ts` (direct invoke functions, for tests) and
                    `sandbox-entry.ts` (postMessage proxies, what the LLM
                    sees). Single source of truth — keep host and worker on
                    this helper so they cannot drift.
rpc-types.ts        Host↔worker message shapes.
```

## Invariants

- **Single tool surface.** This plugin registers exactly one tool. Adding more should be a separate plugin.
- **Self-exclusion in the description.** The rendered .d.ts must NOT include `execute_typescript` itself; it lists every OTHER registered tool. Recursion is meaningless here.
- **`tool:progress` emission requires `outerCallId`.** The handler in `index.ts` passes `exec.callId` to `runInSandbox`. Without that, no progress emits.
- **No system-prompt mutation.** Unlike `llm-codemode-dispatch`, this plugin does not consume `prompt:registry`. The API surface lives in the tool description.
- **No code-from-prose extraction.** The LLM emits `tool_calls` with `code` as the argument. There is no fence parsing.
- **No TUI integration code in this plugin.** The `execute_typescript` renderer for the TUI now lives in `llm-tui/tool-renderers/defaults.tsx`. This plugin does not consume `ui:tool-renderer`, does not import `react` or `ink`, and runs identically whether or not `llm-tui` is in the harness.

## Local deploy

Build from the source directory (where workspace deps resolve), then sync into the install dir:

```bash
PLUGIN=llm-codemode
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

`sandbox-entry.ts` is loaded by URL at runtime — it must remain present alongside the bundle. Do not bundle it into `dist/index.js`.

**No React/Ink in this plugin.** The TUI rendering of `execute_typescript` lives in `llm-tui/tool-renderers/defaults.tsx` (alongside the renderers for `edit`/`write`/`bash`). It must stay there: `kaizen marketplace update` bundles every plugin hermetically with its own React, so a renderer registered from this plugin would create JSX with a different React instance than the one `llm-tui`'s Ink reconciler uses, blowing up with `dispatcher.useContext is null`.
