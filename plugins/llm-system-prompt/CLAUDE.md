# Working in `llm-system-prompt`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts        Plugin lifecycle: consumes llm-events vocabulary, wires service, registers identity at p=10,
                and registers slash commands when slash:registry is present.
                The only file that touches `ctx`.
registry.ts     createRegistry({ emit }) → SystemPromptServiceImpl. Pure logic. Owns generation counter
                and assembly cache. Handle-scoped ownership: each register() returns an unregister/bumpGeneration handle.
identity.ts     resolveIdentity({ globalPath, projectPath, env? }) → { section, reload }. Pure logic.
                Caches file contents in closure; date is interpolated per render() (not cached).
slash.ts        makePromptSlashHandlers({ registry, reloadIdentity }) → { show, reload, disable, enable }.
                Pure factory; no state.
public.d.ts     Exported types — SystemPromptSection, RegisteredSection, SystemPromptService.
                The canonical service contract.
```

Boundaries:
- `registry.ts` and `identity.ts` are the only stateful modules. `slash.ts` is stateless.
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- Tests for each module live alongside in `test/` and run independently (`bun test`).

## Invariants

- **Cache identity, not equality.** `assemble()` returns the *same string instance* between generations. Tests assert `s1 === s2`. Don't replace the cache with deep-equal checks.
- **Generation increments on every mutation.** register, unregister, bumpGeneration, disable, enable, and identity reload all bump. The driver's cache trusts this.
- **Render errors do not propagate.** A section's `render()` throwing must be caught and rendered inline as `<!-- render error: … -->`. Failing one section must not break the whole assembly.
- **Empty sections are dropped.** A section that renders `""` is omitted entirely (no blank `## title` block).
- **Re-registering a live id throws.** Callers must `unregister()` first. Idempotent unregister is fine — second call is a no-op.

## Adding a section from another plugin

```typescript
const promptSystem = ctx.useService<SystemPromptService>("prompt:system");
const handle = promptSystem.register({
  id: "my-plugin:my-section",
  priority: 200,            // 10 = identity, higher = later in prompt
  title: "Custom heading",  // optional; emitted as `## Custom heading`
  render: async () => "body text",
});

// On state change:
handle.bumpGeneration();    // forces re-assembly on next call

// On teardown:
handle.unregister();
```

Use a namespaced id (`plugin-name:section-name`) to avoid collisions.

## Editing identity behavior

`identity.ts` is intentionally narrow — global+project file merge, env kill-switch, fallback. Don't add features here; if a peer plugin needs different behavior, it should register its own section instead of changing identity.

The `FALLBACK_TEMPLATE` is the prompt users see when neither file exists. Treat changes to it as user-visible — update tests and document the new wording.

## Testing

```bash
cd plugins/llm-system-prompt && bun test
```

Tests use `bun:test` only — no external mocking framework. Fixtures for identity live under `test/fixtures/`.

When adding tests for the lifecycle, use the `makeFakeCtx()` helper in `test/index.test.ts` rather than spinning up a real Kaizen runtime.

## Local deploy

The Kaizen runtime prefers the bundled `dist/index.js` over source. After editing, the plugin must be re-bundled into the install dir:

```bash
cp -R plugins/llm-system-prompt/. ~/.kaizen/marketplaces/official/plugins/llm-system-prompt@0.1.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-system-prompt@0.1.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
