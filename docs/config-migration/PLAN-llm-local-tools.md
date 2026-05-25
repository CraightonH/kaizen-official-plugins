# PLAN — `llm-local-tools` → `config:store`

## Current state

No `process.env.*` reads anywhere in the plugin (verified by `grep -rn 'process.env' plugins/llm-local-tools --include='*.ts'` returns empty outside of tests).

All tunables live as hardcoded module-level constants in `util.ts`, and are explicitly advertised in the user-facing README as the configuration surface (`README.md:171-173`: "Configuration: No environment variables. All limits live in `util.ts` as named constants…"). The CLAUDE.md invariants section (`CLAUDE.md:54`) lists the same constants and asserts "Tools import them; do not re-declare per-tool defaults."

Inventoried knobs:

| Constant | Default | Site of declaration | Used by |
|---|---|---|---|
| `MAX_READ_BYTES` | 50 MB | `util.ts:6` | `tools/read.ts:40` (hard refusal threshold) |
| `READ_CAP_BYTES` | 256 KB | `util.ts:7` | `tools/read.ts:63-66,72` (read truncation cap) |
| `READ_CAP_LINES` | 2000 | `util.ts:8` | `tools/read.ts:49-50,72` (read line cap + default `limit`) |
| `BASH_OUTPUT_CAP` | 256 KB | `util.ts:9` | `tools/bash.ts:96-98` (bash output truncation) |
| `GREP_DEFAULT_MAX` | 200 | `util.ts:10` | `tools/grep.ts:90,161` (grep default `max_results`) |
| `GLOB_CAP` | 1000 | `util.ts:11` | `tools/glob.ts:111,113` (glob result cap) |
| `WEB_FETCH_CAP_BYTES` | 512 KB | `util.ts:12` | `tools/web_fetch.ts:70` (in-context body cap default) |
| `WEB_FETCH_DOWNLOAD_CAP_BYTES` | 50 MB | `util.ts:13` | `tools/web_fetch.ts:134-136` (save-to-disk hard cap) |
| `WEB_FETCH_DEFAULT_TIMEOUT_MS` | 30000 | `util.ts:14` | `tools/web_fetch.ts:69` (web_fetch default timeout) |

Two more user-meaningful defaults are inline literals rather than named constants in `util.ts`:

| Inline literal | Default | Site |
|---|---|---|
| Bash default timeout | 120000 ms | `tools/bash.ts:49` (`args.timeout ?? 120000`) |
| Bash hard max timeout | 600000 ms | `tools/bash.ts:49` and schema `tools/bash.ts:14` |

Tool-call argument hard caps (`bash` 600 s ceiling, `web_fetch` 120 s ceiling, etc.) are advertised in the JSON schema description strings the LLM sees. Those `maximum:` schema values, plus the schema `description` text, are tied to the constants — if we make a constant configurable, the schema string the LLM sees will be wrong unless we either rebuild schemas after `config:get` or keep schema strings static and only thread the default into the handler.

Constructor/setup args: none. `index.ts:21-34` just resolves `tools:registry` and registers every entry from `ALL_TOOLS` (a static array exported from `tools.ts`). There is no factory threading any knob in today.

Custom config-file readers: none. Plugin has zero on-disk config today.

`fs.read`/`fs.write` permissions: plugin manifest declares `tier: trusted` and no scoped fs permissions to strip (`index.ts:13`).

## Proposed `LlmLocalToolsConfig`

```ts
// plugins/llm-local-tools/public.d.ts (addition)
export interface LlmLocalToolsConfig {
  // read
  readMaxBytes: number;       // hard refusal threshold for `read`
  readCapBytes: number;       // truncation cap for returned body
  readCapLines: number;       // line cap + default `limit`
  // bash
  bashOutputCap: number;      // bash output middle-truncation threshold
  bashDefaultTimeoutMs: number; // default `timeout` when caller omits it
  // grep
  grepDefaultMax: number;     // default `max_results` when caller omits it
  // glob
  globCap: number;            // hard cap on glob result count
  // web_fetch
  webFetchCapBytes: number;            // default in-context body cap
  webFetchDownloadCapBytes: number;    // hard cap on save_to file size
  webFetchDefaultTimeoutMs: number;    // default `timeout_ms` when caller omits it
}
```

Notes:

- `MAX_READ_BYTES` → `readMaxBytes`. It is a hard refusal and *not* exposed as a tool arg. A user who works with very large generated files (datasets, ML weights) plausibly wants to raise it.
- Bash *hard max* (600 s, schema `maximum:`) is intentionally NOT exposed. Schemas are emitted once at registration and the LLM reads the `maximum:` value; making it configurable would require schema rebuild on `watch()`. Out of scope for v1.
- Same reasoning excludes `web_fetch.timeout_ms` schema `maximum: 120000` — kept as a static guard.
- The `description` strings in tool schemas that reference defaults (e.g. `tools/web_fetch.ts:23`, `tools/bash.ts:8,14`) will be slightly stale if the user overrides the default. Acceptable v1 trade-off — they are guidance, not enforcement. Documented in "Risks".

## Defaults and schema

```ts
// plugins/llm-local-tools/config.ts (new)
import type { FieldSchema } from "llm-contracts/public";
import type { LlmLocalToolsConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: LlmLocalToolsConfig = Object.freeze({
  readMaxBytes: 50 * 1024 * 1024,
  readCapBytes: 256 * 1024,
  readCapLines: 2000,
  bashOutputCap: 256 * 1024,
  bashDefaultTimeoutMs: 120_000,
  grepDefaultMax: 200,
  globCap: 1000,
  webFetchCapBytes: 512 * 1024,
  webFetchDownloadCapBytes: 50 * 1024 * 1024,
  webFetchDefaultTimeoutMs: 30_000,
}) as LlmLocalToolsConfig;

export const CONFIG_SCHEMA: Record<keyof LlmLocalToolsConfig, FieldSchema> = {
  readMaxBytes:             { type: "number", min: 1024, integer: true },
  readCapBytes:             { type: "number", min: 1024, integer: true },
  readCapLines:             { type: "number", min: 1,    integer: true },
  bashOutputCap:            { type: "number", min: 1024, integer: true },
  bashDefaultTimeoutMs:     { type: "number", min: 1000, max: 600_000, integer: true },
  grepDefaultMax:           { type: "number", min: 1,    integer: true },
  globCap:                  { type: "number", min: 1,    integer: true },
  webFetchCapBytes:         { type: "number", min: 1024, integer: true },
  webFetchDownloadCapBytes: { type: "number", min: 1024, integer: true },
  webFetchDefaultTimeoutMs: { type: "number", min: 1000, max: 120_000, integer: true },
};
```

`bashDefaultTimeoutMs.max` and `webFetchDefaultTimeoutMs.max` mirror the (still-hardcoded) schema `maximum:` values so a configured default can never exceed the per-call hard cap.

## Code changes

### Add

- `plugins/llm-local-tools/config.ts` — `DEFAULT_CONFIG` + `CONFIG_SCHEMA` per template above. No I/O, no ctx.

### Edit

- `plugins/llm-local-tools/public.d.ts` — add `LlmLocalToolsConfig` interface (keep TOOL_NAMES and existing re-exports).

- `plugins/llm-local-tools/index.ts`:
  - Import `ConfigStoreService` from `llm-contracts/public`, `DEFAULT_CONFIG`/`CONFIG_SCHEMA` from `./config.ts`, `LlmLocalToolsConfig` from `./public.d.ts`.
  - In `setup()`, after resolving `tools:registry`, also resolve `config:store` (topo-hint optional) and `register()` the spec; fall back to `DEFAULT_CONFIG` if absent or `register()` throws (mirror `llm-axioms` pattern).
  - Replace the static `ALL_TOOLS` loop with `buildAllTools(config)` — see next bullet.

- `plugins/llm-local-tools/tools.ts`:
  - Stop re-exporting eight static `{schema, handler}` constants directly. Convert to a `buildAllTools(config: LlmLocalToolsConfig): ReadonlyArray<{schema, handler}>` factory that calls into each per-tool module's new builder.
  - Alternative (lower-blast-radius): keep `tools.ts` flat, but each per-tool module exports `makeRead(config)`/`makeBash(config)`/etc. instead of static `handler`. Pick this if `scaffold.test.ts` couples to the existing `ALL_TOOLS` symbol shape. Verify against the test before choosing.

- `plugins/llm-local-tools/tools/read.ts`:
  - Stop importing `MAX_READ_BYTES`/`READ_CAP_BYTES`/`READ_CAP_LINES` from `util.ts`.
  - Export `makeHandler(config)` returning the existing handler closure that reads `config.readMaxBytes`/`readCapBytes`/`readCapLines`.
  - `schema` stays static (no description rewriting in v1).

- `plugins/llm-local-tools/tools/bash.ts`:
  - Closure over `config.bashOutputCap` and `config.bashDefaultTimeoutMs`.
  - Line 49: `Math.min(600000, Math.max(1000, args.timeout ?? config.bashDefaultTimeoutMs))`.
  - Line 96-98: substitute `config.bashOutputCap`.

- `plugins/llm-local-tools/tools/grep.ts`: closure over `config.grepDefaultMax`; lines 90 + 161.

- `plugins/llm-local-tools/tools/glob.ts`: closure over `config.globCap`; lines 111 + 113.

- `plugins/llm-local-tools/tools/web_fetch.ts`:
  - Closure over `config.webFetchCapBytes`, `config.webFetchDownloadCapBytes`, `config.webFetchDefaultTimeoutMs`.
  - Lines 69, 70, 134-136.
  - Note: line 24's `description` template-literal still interpolates `WEB_FETCH_CAP_BYTES` for the LLM-visible hint. Decision: keep the schema description showing the **default** (frozen from `DEFAULT_CONFIG`) so it's stable across boots; do not rewrite per config-get. Document this in code comment.

- `plugins/llm-local-tools/tools/write.ts`, `create.ts`, `edit.ts`: no changes — they don't reference any tunable constant.

- `plugins/llm-local-tools/util.ts`:
  - Decide between two choices:
    - **A (recommended).** Delete the nine size-cap exports; constants now live in `config.ts`'s `DEFAULT_CONFIG`. `util.ts` keeps only the pure helpers + `BINARY_CT_*`/`isBinaryContentType` (binary-classification policy, not a knob).
    - **B.** Keep the constants as a re-export of `DEFAULT_CONFIG` field values for backward source-compat. Costs an extra import edge; only worth it if downstream plugins import from `util.ts`. Spot-check shows none do — choose A.

- `plugins/llm-local-tools/CLAUDE.md`:
  - Update the "Caps live in `util.ts`" invariant to "Caps live in `config.ts` as `DEFAULT_CONFIG`; handlers receive them via a closure-bound `config`."
  - Add a one-line module-map entry for `config.ts`.

- `plugins/llm-local-tools/README.md`:
  - Update the "Configuration" section (currently `README.md:171-173`) to point at `config:store` and list the ten config fields. Drop the "No environment variables" sentence.

- `plugins/llm-local-tools/test/scaffold.test.ts` (and any other tests that import the deleted constants from `util.ts` or that build `ALL_TOOLS` directly):
  - If tests build a fake `ctx` and call into `ALL_TOOLS` statically, they need to be updated to call `buildAllTools(DEFAULT_CONFIG)` or equivalent. Per-tool tests that import the handler directly need to use the new `makeHandler(config)` shape.
  - The scaffold-name contract (every expected tool name registered with the right tags) is preserved; only the construction call site changes.

### Delete

- The nine top-level `export const` size-cap declarations in `util.ts:6-14` (move to `config.ts`).
- Nothing else.

## Manifest changes

`plugins/llm-local-tools/package.json` — add `"config:store"` to `services.consumes`. Today the manifest has no `services` block at all *inside* `package.json` (the service block lives in `index.ts` `plugin.services` at runtime — note `index.ts:14-18` already declares `consumes: ["tools:registry"]`). Two possibilities, pick whichever the harness's `kaizen plugin validate` requires:

- If validate enforces `package.json.services.consumes` → add the JSON entry.
- If validate reads `plugin.services.consumes` from the bundled module (current shape) → update the array in `index.ts` to `["tools:registry", "config:store"]` and leave `package.json` alone.

Cross-check against another already-migrated plugin (`llm-axioms`) before writing the patch — apply whichever side `kaizen plugin validate plugins/llm-axioms` accepts.

No `fs.read`/`fs.write` permissions to strip (none declared today). No version bump strictly required by the migration itself, but bump to `0.3.0` to reflect the user-visible behavior change (defaults are now harness-config driven).

## Risks / open questions

1. **Schema `description` strings drift.** Tool schemas embed default values in their LLM-visible `description` strings (e.g., `tools/bash.ts:8` "Default timeout 120s"; `tools/web_fetch.ts:23-24`). After migration, an override won't be reflected in the description the LLM sees. Acceptable trade-off — schemas are emitted once at register and the descriptions are guidance, not enforcement. Documented in code comments. Revisit if a user complains.

2. **Schema `maximum:` values stay hardcoded.** `tools/bash.ts:14` (600000) and `tools/web_fetch.ts:23` (120000) remain hardcoded ceilings because the schema is registered once. If we ever want those configurable, we need to register-then-unregister-then-reregister on `watch()`, which is significantly more code. Out of scope.

3. **Handler closure vs. live `watch()`.** Plan binds `config` at `setup()` time and never re-reads. This matches `llm-axioms`' behavior and the INTEGRATION.md guidance ("If your plugin reads config once in setup() and never again, skip watch()"). Documented as intentional — toggling these requires a kaizen restart. If we later want live reload, wrap each handler's read in `() => currentConfig.field` and use `watch()` to mutate `currentConfig`. Cheap to add later, not worth complicating v1.

4. **`scaffold.test.ts` coupling.** The plugin's `scaffold.test.ts` (per CLAUDE.md:81) asserts `ALL_TOOLS` registers every expected name+tags. If it imports `ALL_TOOLS` as a static array, the test needs a `buildAllTools(DEFAULT_CONFIG)` call. Verify before refactoring.

5. **Refusal-threshold semantics.** `readMaxBytes` is a hard refusal (50 MB) — making it user-configurable means a user can effectively disable that safety. Acceptable: schema enforces `min: 1024`, and the constraint is a user-facing knob, not a security boundary (this plugin is `tier: trusted` and unscoped per its own README warning).

6. **Manifest location ambiguity.** As noted above, the `services.consumes` block today lives in `index.ts` runtime export, not `package.json`. Resolve by cross-checking `kaizen plugin validate` against an already-migrated plugin before patching.

## Contract proposals (only if needed)

None. The existing `ConfigStoreService` / `FieldSchema` surface from `llm-contracts/public` is sufficient — every field is a bounded integer, no new types, no validators, no secrets.
