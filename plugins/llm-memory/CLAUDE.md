# Working in `llm-memory`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts        Plugin lifecycle: loads config, resolves dirs, ensures global dir + sweeps stale temps,
                wires `memory:store`, registers a `prompt:registry` section that injects the memory block
                (id `llm-memory:auto`, priority 170), registers `memory_recall`/`memory_save` into
                `tools:registry` (optional), and (if autoExtract) subscribes to `turn:end`.
                The only file that touches `ctx`. Module-scope handles (`sectionHandle`, `toolsUnregister`)
                let `stop()` clean up idempotently on reload.
config.ts       loadConfig({ home, env, readFile, log }) → MemoryConfig. Reads
                `~/.kaizen/plugins/llm-memory/config.json` (or KAIZEN_LLM_MEMORY_CONFIG override).
                Pure logic; defaults frozen as DEFAULT_CONFIG. Validates injectionByteCap, staleTempMs,
                denyTypes.
paths.ts        resolveDirs (home/cwd + config → { globalDir, projectDir }), ensureDir,
                listMemoryFiles (skips MEMORY.md, dotfiles, non-.md), sweepStaleTempFiles.
                Pure FS helpers.
frontmatter.ts  parseEntry / renderEntry / validateName. The on-disk schema lives here.
                `name` regex: [a-z0-9_-]{1,64}.
store.ts        makeStore({ globalDir, projectDir, regenerateIndex, log, now? }) → MemoryStoreService.
                All CRUD + atomic-write logic. `now` is injectable for deterministic tests.
catalog.ts      regenerateIndex(dir): re-reads every entry's frontmatter, rewrites the catalog block
                between markers via mergeIntoIndex, atomic-writes MEMORY.md. Owns CATALOG_START/END.
service.ts      Thin wire-up: makeMemoryStore = makeStore + catalog.regenerateIndex. Keeps `store.ts`
                ignorant of catalog rendering.
injection.ts    buildMemoryBlock({ projectIndex, globalIndex, projectEntries, globalEntries,
                projectPath, byteCap }) → string | null. Pure render. Returns null when nothing to inject.
extract.ts      hasTrigger + maybeExtract. Pure logic; depends only on a `runConversation` fn.
tools.ts        registerTools(registry, store, { log, denyTypes }). Pure factory; returns an unregister.
public.d.ts     Exported types — MemoryEntry, MemoryScope, MemoryType, MemoryStoreService.
                The canonical service contract.
```

Boundaries:
- `store.ts` and `catalog.ts` are the only modules that touch the disk.
- `service.ts` is the seam that injects `regenerateIndex` into the store; nothing else should import `catalog.ts` from `store.ts`.
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- Tests live alongside in `test/` and run independently (`bun test`).

## Invariants

- **Atomic writes everywhere.** Both entry files and `MEMORY.md` go through `<name>.tmp.<pid>.<rand>` + `rename()`. Never write a file in place. A racing writer just overwrites — that is fine because the catalog is rebuilt from the on-disk file set on every write.
- **Catalog is ground truth, derived.** `regenerateIndex` reads all entry frontmatter and rewrites the block between markers; user content above is preserved byte-for-byte. Do not cache catalog state in memory.
- **Markers are appended, never injected mid-document.** Hand-authored `MEMORY.md` without markers gets the catalog block appended at the end on first write. Do not move existing content around.
- **`created` is preserved across overwrites; `updated` is refreshed on every put.** `store.put` reads the existing file first to recover `created`. Tests rely on this — don't simplify.
- **Memory contributes via `prompt:registry`.** The section renders the existing self-contained block (with `<system-reminder>` wrapper and `# Persistent memory` heading); no system-prompt mutation occurs in the plugin. Empty render (both layers empty) returns `""` and the registry drops the section for that call. Never mutate `request.systemPrompt` directly or touch `messages[]`.
- **No-op when empty.** If both layers have no `MEMORY.md` and no entries, `buildMemoryBlock` returns `null` and the listener makes no mutation. No empty `<system-reminder>` blocks.
- **`denyTypes` filters both injection AND `memory_recall` results.** Keep the two paths in sync. Tests assert this.
- **Project shadows global on collision** in `get()` with no scope and in `memory_recall({ names })`. Don't reorder the scope-walk.
- **`name` validation gates every public mutation.** Invalid names → `get`/`remove` return null/no-op; `put` throws. Don't bypass `validateName`.
- **Auto-extraction is OFF by default and gated by `reason === "complete"` + trigger match.** Heuristic miss must not issue a side call. Tests use a spy on `runConversation`.

## Adding a memory writer from another plugin

```typescript
const memory = ctx.useService<MemoryStoreService>("memory:store");
await memory.put({
  name: "vault_namespace",
  description: "Vault namespace is \"admin\"",
  type: "reference",
  scope: "global",        // or "project"
  body: "# Vault\n\nUse namespace `admin` for OIDC...",
});
```

Names must match `[a-z0-9_-]{1,64}`. Use `description` (max 200 chars) — that is what is shown in the injected catalog and what `search()`/`memory_recall` match against.

## Adding a new memory `type`

`MemoryType` is exported from `public.d.ts` and re-validated in three places: `frontmatter.ts` (parse), `tools.ts` (JSON schema enums), and `config.ts` (`VALID_TYPES` for `denyTypes`). Update all three together and add a fixture.

## Editing injection

`injection.ts` is intentionally narrow — header text, per-layer body cap, catalog truncation order. Don't add features here; if a peer plugin needs different behavior, it should write its own block via `prompt:registry`.

The header text and the `(use the memory_recall tool to load any of these)` hint are user-visible — treat changes as documentation-affecting.

## Auto-extraction risks

- Side calls cost tokens. Heuristic gating in `extract.ts:hasTrigger` keeps it rare but not free.
- The model may save things the user did not intend. Surface every write through `tools:registry` events so the TUI can show them.
- If `driver:run-conversation` is unavailable, log and skip. Do not fall back to writing without the model in the loop.

## Testing

```bash
cd plugins/llm-memory && bun test
```

Tests use `bun:test` only — no external mocking framework. Each module's tests are self-contained:
- FS-touching tests (`store.test.ts`, `catalog.test.ts`, `paths.test.ts`, `service.test.ts`, `fixtures.test.ts`) use real tmpdirs.
- `injection.test.ts`, `extract.test.ts`, `frontmatter.test.ts`, `config.test.ts` are pure.
- `tools.test.ts` uses an in-memory fake registry.
- `index.test.ts` uses a fake `ctx` to exercise the lifecycle without a real Kaizen runtime.

Fixtures live under `test/fixtures/` — these include Claude-Code-shaped memories used to verify portability.

When adding a new disk-touching test, always use `mkdtemp` under `os.tmpdir()` and clean up in an `afterEach`. Do not rely on cwd.

## Local deploy

The Kaizen runtime prefers the bundled `dist/index.js` over source. After editing, the plugin must be re-bundled into the install dir:

```bash
cp -R plugins/llm-memory/. ~/.kaizen/marketplaces/official/plugins/llm-memory@0.1.2/
(cd ~/.kaizen/marketplaces/official/plugins/llm-memory@0.1.2 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
