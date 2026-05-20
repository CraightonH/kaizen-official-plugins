# Working in `llm-environment`

Notes for agents editing this plugin. See `README.md` for the user contract.

## Module map

```
index.ts         Plugin lifecycle: captures snapshot at setup(), registers section at p=30,
                 best-effort registers /env:refresh and environment_refresh. Only file
                 touching `ctx`.
environment.ts   captureEnvironment({ cwd, env? }) → { section, refresh }. Pure logic.
                 Synchronous git detection (walks up for .git; reads HEAD directly).
                 No shell-out.
slash.ts         makeEnvSlashHandlers({ refresh }) → { refresh }. Stateless factory.
tool.ts          makeEnvToolHandlers({ refresh }) → { refresh }. Stateless factory.
                 Exports ENVIRONMENT_REFRESH_SCHEMA constant.
public.d.ts      EnvironmentSnapshot, GitSnapshot. No service is exported.
test/fixtures.ts buildFixtures(root) → FixtureSet. Builds hand-rolled .git/ trees in a
                 tmpdir at test time (git refuses to track paths containing .git/).
```

Boundaries:
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- `environment.ts` is the only stateful module. slash.ts and tool.ts are pure.
- Tests for each module live alongside in `test/` and run independently (`bun test`).

## Invariants

- **Snapshot is static between refresh calls.** `render()` is a synchronous
  cache read; do not add filesystem watchers.
- **`render()` never throws.** Git-detection failures are swallowed and
  surfaced as `git.isRepo = false`.
- **Empty render → section dropped.** `KAIZEN_ENVIRONMENT_DISABLE=1` returns
  `""`; the prompt registry drops empty sections.
- **Non-repo → no git line.** When `isRepo === false`, the `Git branch:` line
  is omitted entirely. Never emit "Git branch: no" or similar.
- **Detached HEAD renders `Git branch: (detached HEAD)`.** `git.branch` is
  `undefined`; the render falls back to the literal `(detached HEAD)`.
- **Malformed HEAD → non-repo.** Whitespace-only or unparseable HEAD content
  is treated as `isRepo: false` (no `Git branch:` line).
- **No shell-out.** Git detection is filesystem-only — walk up for `.git`,
  read `HEAD`, follow `.git`-as-file worktree pointers once.
- **Teardown is idempotent.** `stop()` drains every handle; second call is a
  no-op.

## Fixtures cannot be static

Git's `update-index` refuses to track any path containing `.git/`. The
fixtures must be created at test time inside a tmpdir, via the
`buildFixtures()` helper in `test/fixtures.ts`. Each test file that needs
fixtures creates a `mkdtempSync` root in `beforeAll` and removes it in
`afterAll`.

## Adding a new field (e.g. timezone, locale)

1. Add the field to `EnvironmentSnapshot` in `public.d.ts`.
2. Populate it inside `refresh()` in `environment.ts`.
3. Append a render line in `render()`.
4. Add tests in `test/environment.test.ts`.

The kill switches and refresh plumbing need no changes.

## Testing

```bash
cd plugins/llm-environment && bun test
```

Tests use `bun:test` only. Fixtures are built per-test in tmpdirs (see above).
Tests must not write outside their own tmpdir.

## Local deploy

The Kaizen runtime prefers the bundled `dist/index.js` over source. After
editing:

```bash
cd plugins/llm-environment
bun build --target=bun --outfile=dist/index.js index.ts
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/llm-environment@0.1.0
mkdir -p "$INSTALL_DIR"
rsync -a --exclude=node_modules --exclude=dist ./ "$INSTALL_DIR/"
cp dist/index.js "$INSTALL_DIR/dist/index.js"
```

If the harness manifest needs to pick up the new plugin, also sync the local
marketplace repo at `~/.kaizen/marketplaces/official/repo/`.
