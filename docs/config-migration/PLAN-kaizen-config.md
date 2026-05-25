# PLAN — `kaizen-config` (self-audit)

Audit of `plugins/kaizen-config/` for consistency with the integration
patterns it documents in `docs/config-migration/INTEGRATION.md`. The plugin
provides `config:store`, so it has no consumer-side topo-hint to worry
about, but its self-registration and docs are still expected to match the
shapes the rest of the ecosystem is being migrated to.

## Current state

- Self-registers a single field at `plugins/kaizen-config/index.ts:74-80`:
  - `plugin: "kaizen-config"` (matches manifest `name` ✓)
  - `defaults: { defaultSecretBackend: undefined as string | undefined }`
    — inline literal, not a frozen `DEFAULT_CONFIG`, not spread-copied.
  - `schema: { defaultSecretBackend: { type: "string" } }` — inline.
- No `config.ts` module. No `KaizenConfigConfig` interface in
  `public.d.ts` (the file is `export {};`).
- Reads `process.env.EDITOR` at `index.ts:89` with a hardcoded `"vi"`
  fallback and threads it into `slash.ts` as `deps.editor`.
- Reads `process.env` for the env-resolver registration and the store's
  env-override path; these are infrastructure for the contract, not
  user-tunable behavior.
- Manifest has `services.provides: ["config:store", "secrets:registry"]`
  and `consumes: ["slash:registry"]`. No `config:store` self-consume
  (correct — it's the provider).
- `README.md` describes a non-existent API surface and contradicts the
  env-var stance documented in `INTEGRATION.md`.
- `CLAUDE.md` repeats the same env-var-wins claim.

## Issues found

### Missed knobs

1. **`$EDITOR` resolution for `/config:edit`** (`index.ts:89`).
   `process.env.EDITOR ?? "vi"` is exactly the "direct env read /
   hardcoded fallback the user might want to tune" pattern
   `INTEGRATION.md` calls out under "Why migrate". It is user-tunable
   behavior (editor preference, fallback choice) and should be migrated
   to a `kaizen-config` field. Propose:
   - `editor: string | undefined` — when set, used verbatim; when
     `undefined`, fall back to `process.env.EDITOR ?? "vi"`. Keeping the
     env fallback is consistent with the doc's "env vars will be revisited
     later" stance (no `envVars` mapping declared), while still letting
     the user pin a value in `config.json` if they want one.

   This is the only real candidate. The watcher debounce (150 ms) and
   atomic-write tempfile suffix are internal mechanics and explicitly out
   of scope; the env-resolver and store env reads are contract
   infrastructure, not user knobs; `harnessKey` derivation is driven by
   harness identity, not user config.

### Pattern deviations

The plugin's own integration guide (which kaizen-config wrote) is very
specific about the canonical layout. The self-registration violates it
on several points:

1. **No `config.ts` module.** Canonical layout (per `INTEGRATION.md` and
   `llm-axioms/config.ts`) is a pure module exporting
   `DEFAULT_CONFIG = Object.freeze({...})` and
   `CONFIG_SCHEMA: Record<keyof Config, FieldSchema>`. kaizen-config
   inlines both objects into `index.ts`.
2. **No frozen defaults / no spread-copy.** Even with only one field,
   the doc explicitly says "spreading (`{ ...DEFAULT_CONFIG }`) is
   required when handing it to `register()` because the store may mutate
   the object it holds". The current code hands the store the *only*
   instance of the defaults object.
3. **No `KaizenConfigConfig` type.** `public.d.ts` is empty. The doc's
   migration checklist says "Add config type to `public.d.ts`
   (plugin-private, unless cross-plugin needed)". A typed `get<T>` call
   site at `index.ts:97`
   (`store.get<{ defaultSecretBackend?: string }>("kaizen-config")`)
   reinvents the type inline.
4. **`defaults` carries an explicit `undefined`.** The current literal
   `{ defaultSecretBackend: undefined }` works (the validator's
   `if (v === undefined) continue;` short-circuits it) but is awkward
   shape-wise: `Object.keys(defaults)` includes the key, but it's never a
   "real" string default. Either model it as a true optional (omit the
   key from defaults entirely and document the field as optional) or give
   it a sentinel/empty default. Either is more honest than the current
   undefined-as-default.

### Doc drift

1. **`README.md ## Service` describes an API that does not exist.**
   Listed signatures:
   - `register(pluginName, schema)` — actually `register(spec)` taking a
     single `ConfigSpec<T>`.
   - `set(pluginName, field, value)` — actually
     `set(plugin, partial, scope?)` with a partial object and an optional
     `"home" | "project"` scope.
   - `subscribe(pluginName, cb)` — the method is named `watch`.
   - Missing entirely: `get`, `unset`, `list`, `ready`, `getSpec`.
2. **README claims env-var support is a feature.** "Env-var values,
   declared per-field via `register()`, beat all file layers." This is
   the exact pattern `INTEGRATION.md` tells consumers to **not** use
   ("do not declare `envVars`"; env-var resolution is "buggy today").
   The plugin still implements env overrides in `envvars.ts` (used
   internally for the store env-resolver flow), but the user-facing
   README should not advertise it as a stable consumer-facing knob.
3. **`CLAUDE.md` invariants list repeats the env-var-wins claim.**
   "Env-var values beat all file layers. Documented; consumers can
   declare per-field `envVars` mappings via `register()`." Same drift —
   contradicts `INTEGRATION.md`.
4. **Neither doc mentions `defaultSecretBackend`** or the secrets
   pipeline (`secrets:registry`, `selectBackend`, the env scheme,
   `ready()` semantics for `$ref` resolution), even though those are
   first-class user-facing behavior surfaced via `/config:list` and
   `/config:set` on secret fields.
5. **README permissions section is accurate but stale** — claims
   `node:fs` and `node:child_process` use, which is still true; fine.

## Proposed changes

Plan-only — no code in this audit. The fix-up plan:

1. **Add `plugins/kaizen-config/config.ts`** with:
   ```ts
   export interface KaizenConfigConfig {
     defaultSecretBackend?: string;
     editor?: string;
   }
   export const DEFAULT_CONFIG: KaizenConfigConfig = Object.freeze({
     // both fields intentionally optional — env/built-in fallbacks
     // apply when unset
   }) as KaizenConfigConfig;
   export const CONFIG_SCHEMA: Record<keyof KaizenConfigConfig, FieldSchema> = {
     defaultSecretBackend: { type: "string", min: 1 },
     editor: { type: "string", min: 1 },
   };
   ```
   (Decision point: keep optionals omitted from `defaults`, or carry
   them as explicit `undefined`. Prefer omission — see "Risks" below.)
2. **Export `KaizenConfigConfig` from `public.d.ts`** so the inline type
   at `index.ts:97` and the new `editor` resolution call site can use it.
3. **Rewrite `index.ts:74-80`** to mirror the canonical `llm-axioms`
   shape: `store.register({ plugin: "kaizen-config", defaults: { ...DEFAULT_CONFIG }, schema: CONFIG_SCHEMA });`.
   No try/catch needed (provider self-call; first registration can't
   collide).
4. **Resolve the editor at use time** from
   `store.get<KaizenConfigConfig>("kaizen-config").editor`, falling back
   to `process.env.EDITOR ?? "vi"` when the field is unset. Pass a
   getter into `slash.ts` (`editor: () => string`) the same way
   `defaultSecretBackend` is already passed as a getter, so live edits
   via `/config:set kaizen-config editor=...` take effect without
   restart.
5. **Rewrite `README.md ## Service`** to match the real `ConfigStoreService`
   surface; document `defaultSecretBackend` and `editor` as the two
   self-registered fields; describe secret-field flow and `ready()`
   briefly with a pointer to `INTEGRATION.md` as the deep reference.
6. **Update `README.md` storage / env section and `CLAUDE.md`
   invariants** to drop the "env-var values beat all file layers" claim
   from the user-facing contract. The internal `envvars.ts` machinery
   can remain (it's used for the env *secret* scheme via the registry),
   but it should not be advertised as a consumer knob, in line with
   `INTEGRATION.md`'s "do not declare `envVars`" stance.
7. **Add a short "Self-registered fields" section** to `CLAUDE.md`
   pointing at `config.ts` so future agents touching this plugin don't
   re-inline the schema.

## Risks / open questions

- **`defaults` shape for optional fields.** `INTEGRATION.md`'s example
  defaults are all concrete (`byteCap: 4096`, `enabled: true`). The
  contract doesn't explicitly say defaults must include every key. The
  store's `mergeLayers` iterates only the defaults keys it sees, so
  omitting an optional key means the merged result also lacks the key
  unless a layer sets it — which is the desired behavior for
  `editor`/`defaultSecretBackend`. Worth a quick test pass during
  implementation to confirm `applyEnvOverrides` and `validate` are happy
  with keys absent from `defaults`.
- **`/config:list` resolution display.** Once `editor` is a real field,
  it will show up in the `/config:list` resolution map for the
  `kaizen-config` section. That's an intentional UX improvement (the
  user can see at a glance whether their editor is configured), but it
  is a visible change.
- **Backward compatibility.** No prior file-on-disk format depends on
  `editor` being absent, so adding the field is non-breaking. Existing
  users on `defaultSecretBackend` keep working unchanged (the key name
  and schema don't move).
- **Should `editor` validate as a real executable?** Probably not —
  string-min-1 is sufficient; runtime spawn failure is already handled
  by the existing `spawnEditor` reject path.

## Contract proposals (only if needed)

None. The existing `ConfigSpec<T>` / `ConfigStoreService` surface is
sufficient for everything proposed above. The `editor` field is a plain
optional string with a `min: 1` constraint; no new `FieldSchema` variant
or service method is required.
