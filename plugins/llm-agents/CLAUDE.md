# Working in `llm-agents`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts        Plugin lifecycle: loads config, wires registry handle, turn tracker, injector,
                and dispatch tool. Schedules discovery in a microtask. The only file that
                touches `ctx`.
config.ts       loadConfig({ home, cwd, env, readFile, log }) → AgentsConfig.
                Resolves config path, expands ~ and relatives, validates maxDepth.
loader.ts       loadFromDirs({ userDir, projectDir, deps }) → { manifests, errors }.
                Per-scope load with size cap (64 KiB), symlink-cycle guard, lex-first dedupe.
                Project shadows user; shadowing emits an error record.
frontmatter.ts  parseAgentFile(text, sourcePath) → ParseResult. Strict YAML subset
                (scalars, integers, flow arrays, folded `>-` block scalars). No external YAML lib.
registry.ts     makeRegistry(initial) and makeRegistryHandle(initial). The handle is a stable
                wrapper that lets index.ts swap the inner registry once discovery completes.
                Public list() strips internal fields; register() restricts to `runtime:` names.
turn-tracker.ts makeTurnTracker() — Map<turnId, TurnRecord> driven by turn:start / turn:end.
                Source of truth for depth and "is top-level".
injector.ts     makeInjector({ ctx, tracker }) — subscribes to turn:start/end to drive the
                turn tracker. Also exports buildAgentsBlock for the prompt:system section.
depth.ts        computeDepth(records, turnId) — counts agent-trigger ancestors back to
                the user turn. 1024-iteration safety guard.
tool-filter.ts  Glob matcher for manifest `tools` patterns and toolMatches() helper. Pure.
dispatch.ts     makeDispatchTool({ registry, tracker, driver, maxDepth, hasSkills }) →
                { schema, handler }. Reads ctx.turnId, builds RunConversationInput
                from llm-driver/public, recurses.
public.d.ts     Re-exports AgentManifest and AgentsRegistryService from llm-events/public.
                The canonical service contract lives in the events VOCAB.
```

Boundaries:
- `index.ts` is the only file that imports `kaizen/types` or touches `ctx`.
- `registry.ts` and `turn-tracker.ts` are the only stateful modules.
- `frontmatter.ts`, `loader.ts`, `depth.ts`, `tool-filter.ts`, `injector.ts`, `dispatch.ts`, and `config.ts` are pure factories — all I/O and clocks come in via injected deps.
- Tests live alongside in `test/` and run independently (`bun test`).

## Invariants

- **Registry handle is stable.** `index.ts` registers `agents:registry` once at setup with a `RegistryHandle`. Discovery mutates the inner registry via `setInner()`; consumers keep their reference. Don't replace this with re-registration.
- **Discovery is non-blocking.** `setup()` returns before discovery completes. While `ready === false`, the dispatch handler throws `Agent registry still loading; retry` — which surfaces as a tool error, not a crash. Don't await discovery in `setup()`.
- **Depth uses the turn tracker, not the bus.** Depth is computed from the in-memory `Map<turnId, TurnRecord>` walking `parentTurnId`. The driver must emit `turn:start` with the chain or depth degrades to 0. Don't try to recompute depth from event history.
- **Injection runs at most once per top-level turn.** A `Set<turnId>` is cleared on `turn:end`. Multi-call top-level turns must inject only on the first call; nested turns must not inject at all.
- **Dispatch failures are tool errors.** Unknown agent, depth exceeded, cancellation, sub-conversation throw, and registry-not-ready all `throw` from the handler. The driver converts these to `tool:error`. Never let the plugin crash the parent turn.
- **Always-on tools are merged in, never out.** Sub-agents always see `dispatch_agent` (so they can recurse to `maxDepth`) and, if `skills:registry` is present, `load_skill`. A manifest cannot opt out.
- **Programmatic agents are namespaced.** `register()` requires the `runtime:` prefix. This keeps file-loaded and synthetic agents in disjoint namespaces.
- **Frontmatter parser is strict-subset on purpose.** Only scalars, integers, flow arrays, and `>-` folded block scalars. Don't pull in a real YAML lib — the test surface depends on the deterministic error messages.

## Adding an agent file

User-scope (cross-project):

```bash
mkdir -p ~/.kaizen/agents
cat > ~/.kaizen/agents/code-reviewer.md <<'MD'
---
name: code-reviewer
description: >-
  Use when the user wants a focused review of a diff or specific file.
tools: ["read_file", "list_files", "grep*"]
tags: ["read-only"]
model: gpt-4o-mini
---
You are a focused code reviewer. ...
MD
```

Project-scope (shadows user-scope):

```bash
mkdir -p .kaizen/agents
# same file shape; this one wins on name collision
```

A working sample lives at `examples/code-reviewer.md`.

## Adding a synthetic agent from another plugin

```typescript
const agents = ctx.useService<AgentsRegistryService>("agents:registry");
const unregister = agents.register({
  name: "runtime:my-plugin:router",       // MUST start with `runtime:`
  description: "Routes between specialist agents based on the request.",
  systemPrompt: "You are a router. ...",
  toolFilter: { names: ["dispatch_agent"] },
});
// later: unregister();
```

## Editing dispatch behavior

`dispatch.ts` is intentionally narrow — lookup, depth check, build input, recurse, return. Any new behavior (retry, fanout, streaming) should go in a separate module that wraps the handler. Keep the depth check and the always-on tool merge in dispatch — those are load-bearing.

`ctx.turnId` on `ToolExecutionContext` is required. If the driver stops providing it, depth tracking breaks; the handler will throw rather than guess.

## Testing

```bash
cd plugins/llm-agents && bun test
```

Tests use `bun:test` only — no external mocking framework. Loader tests use `test/fixtures/` for synthetic agent files; dispatch and injector tests use hand-rolled fakes for `ctx`, the driver, and the tools registry.

When adding tests for the lifecycle, build the registry handle and turn tracker directly rather than spinning up a real Kaizen runtime.

## Local deploy

The Kaizen runtime prefers the bundled `dist/index.js` over source. After editing, the plugin must be re-bundled into the install dir:

```bash
cp -R plugins/llm-agents/. ~/.kaizen/marketplaces/official/plugins/llm-agents@0.1.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-agents@0.1.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
