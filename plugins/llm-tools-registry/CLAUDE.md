# Working in `llm-tools-registry`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts        Plugin lifecycle: provides the tools:registry service (defineService is in
                llm-contracts), wires emit, hands the registry instance to provideService.
                The only file that touches `ctx`.
registry.ts     makeRegistry(emit) → ToolsRegistryService. Pure logic. Owns the
                Map<name, { schema, handler }> and the invoke() event sequencing.
                list()/listRegistrations() accept an optional filter with
                names/tags/sources allowlist halves and excludeNames/excludeTags
                denylist halves (exact-name match for names/excludeNames).
public.d.ts     Re-exports contract types from llm-contracts/public only. All public
                types (ToolsRegistryService, ToolHandler, ToolExecutionContext,
                ToolSchema, ToolCall, ChatMessage, CANCEL_TOOL) live in
                llm-contracts/public; this file re-exports them for convenience.
```

Boundaries:
- `registry.ts` is the only stateful module. It takes `emit` as a constructor argument; it never imports `kaizen/types` and never sees `ctx`.
- Only `index.ts` imports `kaizen/types` or touches `ctx`. `defineService` is in `llm-contracts/index.ts`, not here.
- The cancellation sentinel is `Symbol.for("kaizen.cancel")` — a well-known key. Do not switch to a local `Symbol()` or subscribers in other plugins will break.
- Tests live alongside under `test/` and run with `bun test`. No external mocking framework.

## Invariants

- **Single chokepoint for execution.** Every tool call goes through `invoke()`. Dispatch strategies (native, code-mode) MUST NOT call handlers directly — they exist only to translate LLM output into `registry.invoke(...)` calls. This is what makes the `tool:*` event stream uniform.
- **`tool:before-execute` payload is mutable; `tool:execute` is not.** Subscribers rewrite or cancel via the before-execute payload. The registry awaits all subscribers (sequential bus dispatch) before reading the final `args`. Concurrent invocations get independent payloads.
- **`CANCEL_TOOL` short-circuits cleanly.** When `payload.args === CANCEL_TOOL` after before-execute: skip the handler, skip `tool:execute`, skip `tool:result`, emit `tool:error` with `message: "cancelled by subscriber"`, reject with an error whose `name` is `"AbortError"`.
- **Unknown tool path emits `tool:error`, not `tool:before-execute`.** There is nothing to cancel for a tool that does not exist. The error message format is exactly `unknown tool: <name>`.
- **Handler errors propagate.** Catch the throw, emit `tool:error` with `{ message: String(err.message ?? err), cause: err }`, then re-reject with the **original** error object (not a wrapped one). Tests assert `rejects.toBe(boom)`, not `rejects.toThrow(...)`.
- **Duplicate `register` throws.** Hot-swap is `unregister()` then `register()`, never silent replace. Empty `schema.name` also throws.
- **`unregister` is reference-scoped and idempotent.** Use the entry reference, not the name, to decide whether to delete from the map. Second call is a no-op. A same-named replacement registered after the original `unregister` ran must survive a stale unregister call.
- **`list()` returns a fresh array.** Tests mutate the returned array and re-call `list()` to confirm registry state is intact. Don't optimize this away.
- **No internal subscriptions.** This plugin only emits. It never calls `ctx.on(...)`. If you find yourself wanting to subscribe inside the registry, the feature belongs in a peer plugin.
- **Filter is allow-then-deny.** `matchesFilter` first applies the allowlist halves (names, sources, tags) — if any allowlist gate rejects, the entry is out. Then it applies the denylist halves (excludeNames, excludeTags) — any match denies. A tool in both `names` and `excludeNames` is denied (denylist wins). Matching is by exact tool name (`Set.has`), not glob; this is consistent across both halves.

## Adding a tool from another plugin

```typescript
const tools = ctx.useService<ToolsRegistryService>("tools:registry");
const off = tools.register(
  {
    name: "my-plugin:do-thing",
    description: "Does the thing.",
    parameters: { type: "object", properties: { ... }, additionalProperties: false },
    tags: ["fs"],          // optional; used by list({ tags })
  },
  async (args, ctx) => {
    if (ctx.signal.aborted) throw new Error("aborted");
    return { ok: true };
  },
);

// On teardown:
off();
```

Use a namespaced `name` (`plugin-name:tool-name`) to avoid collisions. Plugins MUST call `off()` in their `teardown` so reloads are clean.

## Cancelling a call from a subscriber

```typescript
import { CANCEL_TOOL } from "llm-contracts/public";

ctx.on("tool:before-execute", (payload) => {
  if (payload.name === "dangerous:thing") {
    payload.args = CANCEL_TOOL;
  }
});
```

The well-known `Symbol.for("kaizen.cancel")` key means you can also produce the sentinel inline (`Symbol.for("kaizen.cancel")`) without importing — both forms are equal.

## Editing `invoke()` event sequencing

The exact event ordering is part of the public contract and is asserted in `test/registry.test.ts`. If you change it:

1. Update the spec (`docs/superpowers/specs/2026-04-30-llm-tools-registry-and-native-dispatch-design.md`) first.
2. Update the test assertions.
3. Coordinate with `llm-native-dispatch` and any other dispatch strategy — they rely on the registry, not their own emissions, for `tool:*` events.

## Testing

```bash
cd plugins/llm-tools-registry && bun test
```

Tests:
- `test/registry.test.ts` — pure-logic tests for `makeRegistry`. Uses a `captureEmit()` helper that records events and supports synchronous-ish subscribers (sufficient for the bus's sequential dispatch model).
- `test/index.test.ts` — lifecycle test. Uses a `makeCtx()` helper rather than spinning up a real Kaizen runtime. Asserts plugin metadata, `defineService` / `provideService` wiring, and that invocation events route through `ctx.emit`.

When adding behavior, prefer extending `registry.test.ts` — `index.test.ts` should stay narrow (lifecycle smoke test only).

## Local deploy

Build from the source directory (where workspace deps resolve), then sync into the install dir:

```bash
PLUGIN=llm-tools-registry
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
