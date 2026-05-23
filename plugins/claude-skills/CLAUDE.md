# Working in `claude-skills`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts          Plugin lifecycle: resolves roots, registers config schema,
                  consumes skills:registry, runs initial scan + registrations,
                  subscribes to turn:start for throttled rescans, drains
                  registrations on stop(). Only file that touches `ctx`.
scan.ts           scanRoots({ projectRoot, userRoot, pluginCacheRoot })
                  → ScannedSkill[]. Pure I/O. Walks the three layouts. Names:
                    project/user → <dir>
                    plugin-cache → <plugin>:<dir>
                  Symlink cycle guard via realpath set. Plugin-cache dedup by
                  lex-highest version per <plugin>:<dir>.
frontmatter.ts    parseFrontmatter(text) → { ok, manifest, body } | { ok: false, error }.
                  Hand-rolled YAML-ish parser. Honors name/description/tokens;
                  silently ignores other keys (including CC's `allowed-tools`).
registrar.ts      reconcile(registry, currentScan, previousSnapshot) → newSnapshot.
                  Pure logic. Diffs by name → contentHash. Calls register/unregister
                  for adds, removes, hash-changes.
hash.ts           contentHash(body) → string. SHA-1 hex.
public.d.ts       Empty.
```

Boundaries:
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- Only `scan.ts` performs filesystem I/O.
- Only `registrar.ts` is stateful (holds the previous snapshot).
- Tests live under `test/` per module. Run with `bun test`.

## Invariants

- **Hard deps:** `skills:registry` and `config:store` are both declared in `services.consumes` AND backed by `consumeService` AND used via `useService`. If either is missing, the plugin refuses to boot. Both are correct — claude-skills has zero value without them.
- **Programmatic-layer ordering:** plugin-cache registers first, then user, then project. Later writers overwrite earlier in `skills:registry`'s programmatic map, which matches the documented precedence (project > user > plugin-cache).
- **Scan never throws.** Bad frontmatter, unreadable files, duplicate-within-layer all skip the offender and emit `harness:error`.
- **Reconcile is hash-keyed.** A skill whose body hasn't changed between scans isn't unregistered/re-registered (would churn `llm-skills`'s prompt-section generation).
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
