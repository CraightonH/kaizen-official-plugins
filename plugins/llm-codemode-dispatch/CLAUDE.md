# Working in `llm-codemode-dispatch`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts          Plugin lifecycle: loads config, defines + provides tool-dispatch:strategy.
                  The only file that touches `ctx`.
config.ts         loadConfig(deps) → CodeModeConfig. Reads ~/.kaizen/plugins/llm-codemode-dispatch/config.json
                  (or KAIZEN_LLM_CODEMODE_CONFIG override). Validates ranges. Returns frozen defaults on ENOENT.
service.ts        makeStrategy(config, deps) → ToolDispatchStrategy. Wires prepareRequest + handleResponse.
                  Pure factory; sandbox runner is closed over via makeHandleResponse(config, runInSandbox).
prepare-request.ts  Async; calls renderDts() and returns { systemPromptAppend } with preamble + example.
                  Never sets `tools`.
dts-render.ts     renderDts(tools) → string. Sorts by name, compiles JSON Schema params with
                  json-schema-to-typescript (one interface per tool), emits the kaizen global block.
                  Memoized on a stable JSON key. Exported _resetCacheForTest() for tests.
extractor.ts      extractCodeBlocks(text, max) → { code, ignoredCount }. Uses mdast-util-from-markdown,
                  filters to ts/typescript/js/javascript langs, requires a closing fence (mdast tolerates
                  unterminated), joins with `\n;\n`.
wrapper.ts        wrapCode(userCode) → { wrapped, transpileError? }. Forbidden-pattern lint, Bun.Transpiler
                  syntax check, trailing-expression rewrite into `return (...)`, async IIFE wrap.
sandbox-host.ts   runInSandbox(code, registry, signal, config, emit?, turnId?). Spawns Worker, owns the
                  message loop, enforces timeout, aggregates stdout, bridges tool RPC, terminates and
                  aborts in-flight tool calls on signal/timeout/crash. Resolves SandboxRunResult; never
                  throws except for AbortError.
sandbox-entry.ts  Worker entrypoint. Curates globalThis, captures Bun.Transpiler + AsyncFunction BEFORE
                  curation, builds the `kaizen.tools` Proxy that posts tool-invoke and awaits tool-result,
                  rebuilds `console` to post stdout, runs user code via `new AsyncFunction(...)` with
                  shadowed dangerous-name parameters.
serialize.ts      stringifyReturn(v) (handles bigint/function/symbol/circular), truncate(s, max),
                  formatResultMessage({ ok, ... }, caps) → "[code execution result]\n..." string.
handle-response.ts  makeHandleResponse(config, runner) → handleResponse(input). Owns the codemode:*
                  emit sequence and the mutable `before-execute` payload contract.
rpc-types.ts      Host↔worker message shapes (InitMsg, ToolInvokeMsg, ToolResultMsg, StdoutMsg,
                  DoneMsg, ErrorMsg). The wire contract.
public.d.ts       Re-exports CodeModeConfig only. The strategy type itself lives in `llm-events/public`.
```

Boundaries:
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- `sandbox-entry.ts` is the *only* file that runs inside the worker. Treat it as a separate world: imports must be type-only or worker-safe, and the file is loaded by URL (see `ENTRY_URL` resolution in `sandbox-host.ts` — it handles both bundled `dist/` and source layouts).
- `dts-render.ts`, `extractor.ts`, `wrapper.ts`, `serialize.ts` are pure and have no I/O.
- Tests for each module live alongside in `test/` and run independently (`bun test`). `test/e2e-sandbox.test.ts` exercises the full host↔worker loop.

## Invariants

- **Code-mode never sets `tools`.** `prepareRequest` returns `{ systemPromptAppend }` only. The driver must not see structured tool definitions from this strategy.
- **Feedback prefix is load-bearing.** Every result message starts with the literal `[code execution result]\n` line. The system prompt instructs the LLM to read it as runtime output, not a new user request. Don't reword the prefix without updating the preamble in `prepare-request.ts`.
- **`handleResponse` always returns `ChatMessage[]`.** Sandbox failures (transpile, timeout, throw, worker crash) become an `exit: error` feedback message, not an exception. The only exception that escapes is `AbortError` from the host signal.
- **No-code → empty array.** When `extractCodeBlocks` returns no usable block, `handleResponse` resolves to `[]` and emits *nothing*. The driver treats that as the LLM's final answer.
- **`codemode:before-execute` payload is mutable.** Subscribers may rewrite `payload.code`; the post-`await emit(...)` value is what executes. Don't deep-clone the payload before emit.
- **Worker is one-shot.** Spawned per `runInSandbox` call, terminated on done/error/timeout/abort. There is no warm pool today; if you add one, the curated-globals contract still has to hold per turn.
- **Bun globals are captured before curation.** `AsyncFunctionCtor` and `BunTranspilerCtor` are read at module-init in `sandbox-entry.ts` because `curateGlobals()` removes `Bun` from `globalThis`. Any new privileged ref must follow the same pattern.
- **Stdout cap is enforced both sides.** Worker stops posting once it hits `maxStdoutBytes`; host re-truncates on drain. Don't drop one side — the worker cap protects the message channel, the host cap protects the prompt.
- **DTS cache key is the tool surface, not identity.** Cache keys on `[name, description, parameters]` per tool, sorted. Don't add tool-list ordering to the key — assembly is determinism-sorted internally.

## Adding behavior

### A new sandbox feature (e.g. `kaizen.env`)

1. Allowlist any new global in `ALLOW_KEYS` in `sandbox-entry.ts` if it needs a real binding, or attach it to the synthesized `kaizen` object in `makeKaizen()`.
2. If it needs to talk to the host, add a message variant to `rpc-types.ts` and handle it in both `sandbox-host.ts` (`worker.onmessage`) and `sandbox-entry.ts` (`self.addEventListener("message", ...)`).
3. Update the preamble in `prepare-request.ts` so the LLM knows it exists.
4. Add a unit test under `test/` and an e2e test in `test/e2e-sandbox.test.ts`.

### A new event

Names live in the `llm-events` VOCAB. Don't `defineEvent` here. To emit a new one, add a vocab entry there first, then call `input.emit(name, payload)` from `handle-response.ts` (or `sandbox-host.ts` for nested tool-call telemetry).

### A new config knob

1. Add it to `CodeModeConfig` in both `config.ts` and `public.d.ts`.
2. Add the default to `DEFAULT_CONFIG` and a range check in `validate()`.
3. Thread it through `makeHandleResponse` / `runInSandbox` if it affects runtime behavior.
4. Document in README.

## Testing

```bash
cd plugins/llm-codemode-dispatch && bun test
```

Tests use `bun:test` only. The e2e suite spawns real Bun Workers; if you change `sandbox-entry.ts`, run `bun test test/e2e-sandbox.test.ts` to confirm the worker still boots after curation. The "model emits garbage" suite in `wrapper.test.ts` and `extractor.test.ts` locks in error message text — those strings are part of what the LLM learns from, treat them as user-visible.

## Local deploy

The Kaizen runtime prefers the bundled `dist/index.js` over source. After editing, the plugin must be re-bundled into the install dir:

```bash
cp -R plugins/llm-codemode-dispatch/. ~/.kaizen/marketplaces/official/plugins/llm-codemode-dispatch@0.1.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-codemode-dispatch@0.1.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

Note: `sandbox-entry.ts` is loaded by URL at runtime (see `ENTRY_URL` in `sandbox-host.ts`) — the host resolves it relative to either `dist/` or the source root, so it must remain present alongside the bundle. Do not bundle it into `dist/index.js`.

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
