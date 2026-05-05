# Working in `llm-hooks-shell`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts     Plugin lifecycle: consumes llm-events:vocabulary, loads config, groups
             entries by event, registers one ctx.on(event) listener per event that
             runs all matching hooks sequentially. The only file that touches `ctx`.
             Owns the cancellation sentinels (CANCEL_TOOL Symbol, CODEMODE_CANCEL_SENTINEL string)
             and the per-event blocking dispatch.
config.ts    loadHookConfigs(deps, vocab) → { entries, warnings }. Pure logic.
             Reads home + project hooks.json, merges (home first), validates each
             entry's event against vocab (throws on unknown), warns on
             block_on_nonzero set on a non-mutable event. Also exports MUTABLE_EVENTS
             and realConfigDeps() (homedir + cwd + readFile injection point).
envify.ts    envify(eventName, payload) → Record<string, string>. Pure logic.
             Flattens payload to EVENT_<UPPER_SNAKE> keys with depth cap 4; always
             sets EVENT_NAME and EVENT_JSON. Also exports camelToUpperSnake.
runner.ts    runHook(entry, baseEnv, deps) → { ok, stderr }. Pure logic.
             Spawns sh -c via deps.exec, applies entry.timeout_ms (default 30s),
             logs stdout lines on success, logs stderr on failure / timeout,
             never throws.
```

Boundaries:
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- All three pure modules are tested independently with their own deps interface (`ConfigDeps`, `RunnerDeps`); `envify.ts` has no deps.
- `index.ts` accepts `(ctx as any)._testHookDeps` to inject a `ConfigDeps` for the lifecycle test.

## Invariants

- **No service registration.** This plugin is a pure event consumer. Do not call `ctx.provideService`.
- **Unknown event names are fatal.** `loadHookConfigs` throws if any entry's `event` is missing from the vocabulary. Do not silently drop — better to fail loud at setup.
- **Sequential per event.** Multiple hooks for the same event run in config order (home file's entries first, then project file's). A blocking failure short-circuits remaining hooks for that delivery.
- **No cross-event serialization.** Hooks for *different* events are independent — the bus may deliver them concurrently. Do not add a global lock.
- **Hooks never crash the harness.** A spawn failure, non-zero exit, or timeout is logged at `warn` and converted to `{ ok: false, stderr }`. `runHook` does not throw.
- **`block_on_nonzero` only meaningful for mutable events.** Set is `{ llm:before-call, tool:before-execute, codemode:before-execute }`. On non-mutable events the flag is ignored with a setup-time warning.
- **Cancellation is in-place mutation of the payload object.** The bus delivery contract requires subscribers to mutate `payload.args` / `payload.code` / `payload.request` directly so downstream subscribers see the cancellation. Don't replace the payload reference.
- **Empty config = silent no-op.** No log line on the happy path; only `warnings` from `loadHookConfigs` are logged. Don't add startup chatter.
- **Depth cap = 4.** `envify` stops descending and stores the JSON blob at the cap. Tests assert the cap; don't change without updating both.

## Adding a new mutable-event cancellation

If a new mutable event is added to the vocabulary:

1. Add it to `MUTABLE_EVENTS` in `config.ts`.
2. Add the cancellation branch to the `if (entry.block_on_nonzero && MUTABLE_EVENTS.has(eventName))` block in `index.ts` — define how the payload is mutated to signal cancel (sentinel value, flag, etc.). Coordinate the sentinel with the plugin that owns the operation.
3. Add a test under `test/index.test.ts` (lifecycle) and `test/integration.test.ts`.

## Editing the env-var translation

`envify.ts` is intentionally narrow — depth-capped recursive flatten + camel→snake. Keep it pure (no `process.env`, no `ctx`). Changes are user-visible: any rename of an `EVENT_*` key breaks user hooks. Update `README.md` payload-translation rules and tests in lockstep.

## Testing

```bash
cd plugins/llm-hooks-shell && bun test
```

Tests use `bun:test` only — no external mocking framework.
- `config.test.ts` — covers home/project merge order, malformed JSON, unknown events, `block_on_nonzero` warnings.
- `envify.test.ts` — flattening, camel→snake, depth cap, `EVENT_NAME` / `EVENT_JSON` invariants.
- `runner.test.ts` — exit 0 stdout-line logging, non-zero stderr logging, timeout treatment, env merge precedence (`entry.env` over base).
- `index.test.ts` — lifecycle via `_testHookDeps` injection on a fake ctx; subscription set; blocking dispatch for each mutable event; non-blocking failure does not cancel.
- `integration.test.ts` — end-to-end against a fake bus.

Fixtures live under `test/fixtures/`.

## Local deploy

The Kaizen runtime prefers the bundled `dist/index.js` over source. After editing, the plugin must be re-bundled into the install dir:

```bash
cp -R plugins/llm-hooks-shell/. ~/.kaizen/marketplaces/official/plugins/llm-hooks-shell@0.1.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-hooks-shell@0.1.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
