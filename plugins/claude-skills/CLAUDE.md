# Working in `claude-skills`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts          Plugin lifecycle: resolves roots, registers config schema,
                  consumes skills:registry, runs initial scan + registrations,
                  subscribes to turn:start for throttled rescans, drains
                  registrations on stop(). Only file that touches `ctx`.
config.ts         DEFAULT_CONFIG (frozen) + CONFIG_SCHEMA for config:store.
scan.ts           scanRoots({ projectRoot, userRoot, pluginCacheRoot })
                  → ScannedSkill[]. Pure I/O. Walks the three layouts. Names:
                    project/user → <dir>
                    plugin-cache → <plugin>:<dir>
                  Symlinks resolved via realpath() (baseDir is canonical).
                  Plugin-cache dedup by lex-highest version per <plugin>:<dir>.
frontmatter.ts    parseFrontmatter(text) → { ok, manifest, body } | { ok: false, error }.
                  Hand-rolled YAML-ish parser. Honors name/description/tokens;
                  silently ignores other keys (including CC's `allowed-tools`).
registrar.ts      reconcile(registry, currentScan, previousSnapshot) → newSnapshot.
                  Pure function (no module-scope state). Diffs by name →
                  contentHash(baseDir + body). Calls register/unregister
                  for adds, removes, hash-changes.
hash.ts           contentHash(body) → string. SHA-1 hex.
public.d.ts       Plugin-internal ClaudeSkillsConfig interface. No cross-plugin
                  surface.
```

Boundaries:
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- Only `scan.ts` performs filesystem I/O.
- Only `index.ts` is stateful (module-scope `snapshot`, `unwatchConfig`, `currentIntervalMs`); `registrar.ts` is a pure function.
- Tests live under `test/` per module. Run with `bun test`.

## Invariants

- **Deps:** `skills:registry` is hard (declared in `services.consumes`, fetched via `useService`; missing service ⇒ plugin throws on boot). `config:store` is topo-hint optional (declared in `services.consumes`, fetched via `useService`; missing service ⇒ falls back to `DEFAULT_CONFIG` and logs). The optional fallback keeps plugin tests with a fake `ctx` working without spinning up `config:store`.
- **Programmatic-layer ordering:** plugin-cache registers first, then user, then project. Later writers overwrite earlier in `skills:registry`'s programmatic map, which matches the documented precedence (project > user > plugin-cache).
- **Scan never throws.** Bad frontmatter, unreadable files, duplicate-within-layer all skip the offender and emit `harness:error`.
- **Reconcile is hash-keyed.** Hash covers both `baseDir` and `body`, so a skill that hasn't changed between scans isn't unregistered/re-registered (would churn `llm-skills`'s prompt-section generation), and a cross-layer precedence flip (same body, different baseDir) is correctly re-registered.
- **`baseDir` is always set and always absolute.** It's the realpath of the directory containing the `SKILL.md`.
- **Stop is idempotent.** All unregister calls wrapped in `try`/`catch`. Re-stops are no-ops.

## Local deploy

```bash
PLUGIN=claude-skills
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```
