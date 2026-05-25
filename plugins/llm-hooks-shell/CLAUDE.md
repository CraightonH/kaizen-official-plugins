# Working in `llm-hooks-shell`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts     Plugin lifecycle: consumes events:vocabulary + config:store, registers
             the HooksConfig spec, reads resolved entries, groups by event, and
             registers one ctx.on(event) listener per event that runs all matching
             hooks sequentially. Owns MUTABLE_EVENTS. The only file that touches `ctx`.
             Imports the cancellation sentinels (`CANCEL_TOOL`, `CODEMODE_CANCEL_SENTINEL`)
             from `llm-events` and applies them in the per-event blocking dispatch.
config.ts    DEFAULT_CONFIG (frozen) + CONFIG_SCHEMA for config:store. Pure module.
             Holds `hooks: []`, `defaultTimeoutMs: 30_000`, `depthCap: 4`.
envify.ts    envify(eventName, payload, depthCap?) → Record<string, string>. Pure logic.
             Flattens payload to EVENT_<UPPER_SNAKE> keys with the configured depth
             cap (default 4); always sets EVENT_NAME and EVENT_JSON. Also exports
             camelToUpperSnake.
runner.ts    runHook(entry, baseEnv, deps, defaultTimeoutMs?) → { ok, stderr }. Pure logic.
             Spawns sh -c via deps.exec, applies entry.timeout_ms or the supplied
             defaultTimeoutMs (fallback 30s). Logs stdout lines on success, logs
             stderr on failure / timeout, never throws.
```

Boundaries:
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- `envify.ts` and `runner.ts` are pure modules tested independently. `runner.ts`
  has its own deps interface (`RunnerDeps`); `envify.ts` has no deps.
- Config is sourced from the harness `config:store` service (topo-hint optional
  with `DEFAULT_CONFIG` fallback). There is no legacy file-reader path.

## Invariants

- **No service registration.** This plugin is a pure event consumer. Do not call `ctx.provideService`.
- **Unknown event names are fatal.** `setup()` throws if any entry's `event` is missing from the vocabulary. Do not silently drop — better to fail loud at setup.
- **Sequential per event.** Multiple hooks for the same event run in config order. A blocking failure short-circuits remaining hooks for that delivery.
- **No cross-event serialization.** Hooks for *different* events are independent — the bus may deliver them concurrently. Do not add a global lock.
- **Hooks never crash the harness.** A spawn failure, non-zero exit, or timeout is logged at `warn` and converted to `{ ok: false, stderr }`. `runHook` does not throw.
- **`block_on_nonzero` only meaningful for mutable events.** Set is `{ llm:before-call, tool:before-execute, codemode:before-execute }`. On non-mutable events the flag is ignored with a setup-time warning.
- **Cancellation is in-place mutation of the payload object.** The bus delivery contract requires subscribers to mutate `payload.args` / `payload.code` / `payload.request` directly so downstream subscribers see the cancellation. Don't replace the payload reference.
- **Empty config = silent no-op.** No log line on the happy path; only the
  block_on_nonzero-on-non-mutable warning is logged. Don't add startup chatter.
- **`config:store` layering — arrays replace, not concat.** Project-layer `hooks`
  fully replaces home-layer `hooks` (per the store's resolution semantics; arrays
  and scalars overwrite, only object-typed fields shallow-merge). Documented as
  the 0.1.2 breaking change in README.
- **Depth cap is configurable; default = 4.** `envify` stops descending at the
  cap and stores the JSON blob. Tests assert the default cap; if you change the
  default, update `config.ts:DEFAULT_CONFIG.depthCap`, `envify.ts`, and the tests
  in lockstep.
- **Default timeout is configurable; default = 30_000 ms.** Per-hook
  `timeout_ms` still overrides the default.

## Adding a new mutable-event cancellation

If a new mutable event is added to the vocabulary:

1. Add it to `MUTABLE_EVENTS` in `index.ts`.
2. Add the cancellation branch to the `if (entry.block_on_nonzero && MUTABLE_EVENTS.has(eventName))` block in `index.ts` — define how the payload is mutated to signal cancel (sentinel value, flag, etc.). Coordinate the sentinel with the plugin that owns the operation.
3. Add a test under `test/index.test.ts` (lifecycle) and `test/integration.test.ts`.

## Editing the env-var translation

`envify.ts` is intentionally narrow — depth-capped recursive flatten + camel→snake. Keep it pure (no `process.env`, no `ctx`). Changes are user-visible: any rename of an `EVENT_*` key breaks user hooks. Update `README.md` payload-translation rules and tests in lockstep.

## Testing

```bash
cd plugins/llm-hooks-shell && bun test
```

Tests use `bun:test` only — no external mocking framework.
- `envify.test.ts` — flattening, camel→snake, depth cap, `EVENT_NAME` / `EVENT_JSON` invariants.
- `runner.test.ts` — exit 0 stdout-line logging, non-zero stderr logging, timeout treatment, env merge precedence (`entry.env` over base).
- `index.test.ts` — lifecycle on a fake ctx that exposes `events:vocabulary` and a fake `config:store`; subscription set; blocking dispatch for each mutable event; non-blocking failure does not cancel; config spec registration is asserted.
- `integration.test.ts` — end-to-end against a fake bus with a fake `config:store`.

Fixtures live under `test/fixtures/` (if/when added).

## Local deploy

Build from the source directory (where workspace deps resolve), then sync into the install dir:

```bash
PLUGIN=llm-hooks-shell
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
