# Working in `llm-workflow`

Notes for agents editing this plugin. See `README.md` for the user-facing contract and `docs/superpowers/specs/2026-05-28-llm-workflow-design.md` for the design.

## Module map

(Populated as the plugin lands. See plan tasks for current module responsibilities.)

## Invariants

- **Sandboxed scripts.** Worker source is evaluated via `AsyncFunction`; primitives are non-configurable, non-writable globals.
- **Determinism guards.** `Date.now()`, `Math.random()`, argless `new Date()` throw inside the worker (preserve resume-readiness).
- **Static meta extraction.** `meta` is parsed via AST before sandbox spawn; `meta` must be a pure literal.
- **One semaphore per RunContext.** Nested `workflow()` shares it. Lifetime cap (1000) is hard.
- **Names from disk match filename basename.** Frontmatter convention `name === path.basename(file, ".ts")`.
- **Programmatic registrations require `runtime:` prefix.** Same convention as llm-agents.

## Local deploy

```bash
PLUGIN=llm-workflow
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

`sandbox-entry.ts` is loaded by URL at runtime — keep it alongside the bundle, do not bundle it into `dist/index.js`.
