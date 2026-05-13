# Working in `llm-native-dispatch`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts             Plugin lifecycle: defines and provides the tool-dispatch:strategy service.
                     The only file that touches `ctx`.
strategy.ts          makeStrategy() → ToolDispatchStrategy. Pure logic. Owns prepareRequest
                     pass-through and the sequential handleResponse loop (per-call invoke +
                     tool messages + abort/cancel handling).
serialize.ts         serializeResult(value) and serializeError(message). Pure helpers.
                     Encodes the string / null-undefined / JSON / circular-fallback rules.
args-validation.ts   isValidToolArgs(value) and malformedArgsMessage(raw). Pure helpers.
                     Treats anything that isn't a plain object/array/null (or is an Error)
                     as malformed; produces the JSON `{ error, raw }` payload.
public.d.ts          Re-exports `ToolDispatchStrategy` only. Underlying contract lives in
                     llm-driver/public; do not re-declare it here.
```

Boundaries:
- `strategy.ts`, `serialize.ts`, and `args-validation.ts` are pure — no `ctx`, no I/O, no module-level state.
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- `ToolDispatchStrategy` is imported from `llm-driver/public`. Foundational LLM types come from `llm-events/public`; tool execution context details come from `llm-tools-registry/public`. Do not redeclare owner-public contracts here.

## Invariants

- **Registry is the sole execution path.** Every tool call goes through `registry.invoke`. Never call a handler directly — the registry owns `tool:before-execute` / `tool:execute` / `tool:result` / `tool:error` emission, and the `CANCEL_TOOL` mutation hook lives there. Bypassing it breaks observability and approvals.
- **Sequential execution, in `response.toolCalls` order.** Local LLMs frequently emit dependent tool calls (e.g. `read_file` then `edit_file`); parallelism would race. Do not introduce `Promise.all` over tool calls without a spec change.
- **Errors become `tool` messages, never thrown.** Unknown tool, handler throw, malformed args, cancellation — all serialize into the tool message `content` so the LLM can react on the next turn. The strategy never lets a tool failure escape `handleResponse`.
- **Strategy never returns the assistant message.** The driver pre-appends the assistant message itself at `loop.ts:237`. The strategy's return contains only `tool` role messages (one per tool call, in `response.toolCalls` order). Terminal (no tool calls) → return `[]`. Non-terminal → return one `tool` message per call. The driver detects "non-terminal" by `newMessages.length > 0`.
- **Abort is well-formed.** When `signal.aborted` mid-loop, fill cancelled tool messages for the current call and every remaining call before returning. The conversation handed back must satisfy the OpenAI rule that every assistant `tool_call` is answered by a matching `tool` message.
- **No re-emission of registry events.** `tool:error` from registry-owned failures (unknown tool / handler throw / `CANCEL_TOOL`) is emitted by the registry, not by the strategy. The strategy only emits `tool:error` directly for failures the registry never saw: malformed arguments and circular-result fallback.
- **`ctx.log` bridges to `status:item-update`.** Key is always `tool:<callId>`. Don't change the key shape — TUI consumers depend on it.

## Adding a new dispatch behavior

This plugin is intentionally minimal. If you find yourself wanting:

- Per-call permission prompts → write a peer plugin that subscribes to `tool:before-execute` and uses `CANCEL_TOOL` (`Symbol.for("kaizen.cancel")`).
- Tool result truncation → belongs in the tool implementation (e.g. `llm-local-tools`), not here.
- Code-mode dispatch → a separate plugin providing `tool-dispatch:strategy`. The driver picks one strategy per setup.
- Parallel execution → spec change required; see the "Open questions" section of the design spec.

Do not bolt these onto `strategy.ts`.

## Testing

```bash
cd plugins/llm-native-dispatch && bun test
```

Tests use `bun:test` only. Files:
- `test/strategy.test.ts` — full `handleResponse` matrix (terminal, single call, multi-call ordering, handler throw, unknown tool, malformed args, abort mid-loop, serialization).
- `test/serialize.test.ts` and `test/args-validation.test.ts` — unit coverage for the pure helpers.
- `test/index.test.ts` — lifecycle wiring with a fake `ctx`.
- `test/integration.test.ts` — exercises the strategy against a real `tools:registry` instance to confirm the registry-emitted event sequence is what the strategy expects.

When mocking the registry in `strategy.test.ts`, mirror the real contract: `invoke` returns a promise that resolves with the handler result or rejects with the original error. Tests rely on `registry.invoke` being awaited sequentially, so a counter in mocked handlers is the right tool to assert ordering.

## Local deploy

The Kaizen runtime prefers the bundled `dist/index.js` over source. After editing, the plugin must be re-bundled into the install dir:

```bash
cp -R plugins/llm-native-dispatch/. ~/.kaizen/marketplaces/official/plugins/llm-native-dispatch@<version>/
(cd ~/.kaizen/marketplaces/official/plugins/llm-native-dispatch@<version> \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

Substitute `<version>` with the version pinned by your local harness manifest (see `harnesses/openai-compatible.json`).

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
