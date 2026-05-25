# Working in `llm-axioms`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts          Plugin lifecycle. Subscribes to session:active-changed.
                  Registers axioms:registry service, two prompt sections,
                  three tools, three slash commands. Only file touching ctx.
config.ts         DEFAULT_CONFIG (frozen) + CONFIG_SCHEMA for config:store.
                  Includes methodologyPriority (default 50) and workspacePriority
                  (default 180) — read once in setup(); changes require harness restart.
paths.ts          resolveAxiomsDir, ensureDir, sessionFilePath, sweepStaleTempFiles.
                  Pure FS helpers.
schema.ts         validateAxiomId, validateAxiomEntry, AxiomValidationError.
                  Pure validators. Owns the [a-z0-9_-]{1,64} regex and length caps.
methodology.ts    METHODOLOGY_TEXT constant + renderMethodology(). Pure, cache-stable.
injection.ts      buildWorkspaceBlock(entries, byteCap). Pure render. Groups by scope;
                  truncates oldest-first when over cap.
store.ts          makeStore({ axiomsDir, log, now? }) → AxiomsRegistryService + swapSession.
                  In-memory Map<id, AxiomEntry> mirrored to disk. Atomic writes
                  (tmp + rename) with rollback on disk failure.
tools.ts          registerTools(reg, store) → unregister fn.
                  Three tools: axiom_record / axiom_amend / axiom_drop.
slash.ts          registerSlashCommands(reg, store) → Array<() => void>.
                  Three commands: axioms:list / axioms:show / axioms:clear.
public.d.ts       Re-exports AxiomEntry, AxiomsRegistryService from llm-contracts/public
                  + plugin-internal AxiomsConfig.
```

Boundaries:
- `store.ts` is the only module that touches disk.
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- Tests for each module live alongside in `test/` and run independently.

## Invariants

- **`onChange` fires exactly once per externally observable mutation.** record/amend/drop/clear/swapSession each fire once after in-memory state has been updated and disk write completed. Validation failures fire zero times. Tests assert this.
- **Disk and memory never diverge.** Every public mutation persists to disk before `onChange` fires. If the disk write fails, in-memory state rolls back and the method rejects.
- **No active session ⇒ tools error gracefully.** Before any `session:active-changed` event arrives, the store has no active session. record/amend/drop reject with `no_active_session`. `list()` returns `[]`. `clear()` is a no-op.
- **Workspace section drops when empty.** `buildWorkspaceBlock([])` returns `null`; section `render()` returns `""`; `prompt:registry` drops the section for that call. No empty `<system-reminder>` blocks.
- **Methodology section is byte-stable across renders.** `renderMethodology()` returns the same string instance between calls (cache identity, not equality).
- **ID validation is the only gate on writes.** Tools that receive an invalid id return `{ ok: false, error: "invalid_id" }` and never reach the store.
- **Drop reasons surface in the event stream.** Tool result includes `{ droppedId, reason }`; the `tool:result` event carries it for the TUI to display.
- **No call into `memory:store`.** Verified by no-import test on the bundled `dist/index.js`.
- **Stop is idempotent.** All unregister fns guarded with try/catch.

## Adding an axiom writer from another plugin

```typescript
const axioms = ctx.useService<AxiomsRegistryService>("axioms:registry");
await axioms.record({
  id: "world-class-means-offline",
  statement: "A world-class calendar must work offline.",
  premises: ["users travel", "networks fail"],
  reasoning: "Offline support is non-negotiable for primary calendar features.",
  scope: "UX baseline",
});
```

Ids must match `[a-z0-9_-]{1,64}`. `statement` ≤ 280 chars; 1-10 `premises` each ≤ 500 chars; `reasoning` ≤ 2000 chars; `scope` ≤ 200 chars.

## Editing methodology text

`methodology.ts` is intentionally narrow — a single canonical text. Changes are user-visible (the model sees the new text immediately). Update the snapshot test in `test/methodology.test.ts` and bump the plugin version.

## Testing

```bash
cd plugins/llm-axioms && bun test
```

`bun:test` only. FS-touching tests use real tmpdirs (`mkdtemp` under `os.tmpdir()`, cleanup in `afterEach`). Lifecycle test uses an in-memory fake ctx.

## Local deploy

The Kaizen runtime prefers the bundled `dist/index.js` over source. After editing:

```bash
PLUGIN=llm-axioms
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
```

`llm-contracts` (currently `0.3.0` — the version that defines `axioms:registry`) must be redeployed before `llm-axioms`.
