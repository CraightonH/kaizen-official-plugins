# Working in `llm-agents`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts        Plugin lifecycle: loads config, wires registry handle, turn tracker, injector,
                dispatch tool, the `prompt:registry` Available-agents section, and the
                `agents:list` / `agents:show` slash commands. Schedules discovery in a
                microtask. Module-scope `toolUnregister` / `sectionHandle` / `slashOffs`
                let `stop()` clean up idempotently on reload. The only file that touches `ctx`.
config.ts       DEFAULT_CONFIG (frozen) + CONFIG_SCHEMA for config:store.
                Pure module — no I/O, no ctx. Defaults: maxDepth=3,
                userDir="~/.kaizen/agents", projectDir=".kaizen/agents".
loader.ts       loadFromDirs({ userDir, projectDir, deps }) → { manifests, errors }.
                Depth-first recursive walk per scope (max depth 8). Hidden dirs (dot-prefix)
                skipped. Per-scope dedupe by lex-first full path. Directory symlink-cycle
                guard via realpath + seenRealPaths.
frontmatter.ts  parseAgentFile(text, sourcePath) → ParseResult. Strict YAML subset
                (scalars, integers, flow arrays, folded `>-` block scalars). No external YAML lib.
registry.ts     makeRegistry(initial) and makeRegistryHandle(initial). The handle exposes
                service/getInternal/getErrors and lets index.ts swap the inner registry and
                load-errors slot via setInner(next, errors?, onChange?).
turn-tracker.ts makeTurnTracker() — Map<turnId, TurnRecord> driven by turn:start / turn:end.
                Source of truth for depth and "is top-level".
injector.ts     makeInjector({ ctx, registry, tracker }) — subscribes to turn:start/end to
                drive the turn tracker. Also exports buildAgentsBlock for the prompt:registry
                section render. No prompt mutation happens here — the section is registered
                in index.ts and rendered on demand by the prompt assembler.
depth.ts        computeDepth(records, turnId) — counts agent-trigger ancestors back to
                the user turn. 1024-iteration safety guard.
tool-filter.ts  Glob matcher for manifest `tools` patterns and toolMatches() helper. Pure.
dispatch.ts     makeDispatchTool({ registry, tracker, driver, sessions, maxDepth, hasSkills,
                emit? }) → { schema, handler }. Reads ctx.turnId / ctx.sessionId, builds
                RunConversationInput from llm-driver/public, recurses. ToolSchema is imported
                from llm-tools-registry/public (the narrowest stable owner re-exports it).
                Status events go through the injected `emit` dep — ToolExecutionContext has
                no emit hook, so the plugin captures `ctx.emit` at setup time.
slash.ts        makeSlashHandlers({ registry }) → { listHandler, showHandler }. Pure factory;
                no ctx. listHandler renders agents from registry.service.list() and appends
                a parse-error footer from registry.getErrors() when non-empty.
public.d.ts     Owns AgentManifest and AgentsRegistryService for this plugin. The service
                name `agents:registry` is owned by llm-agents (defined and provided here);
                the event vocab in events:vocabulary does NOT define this contract.
```

Boundaries:
- `index.ts` is the only file that imports `kaizen/types` or touches `ctx`.
- `registry.ts` and `turn-tracker.ts` are the only stateful modules.
- `frontmatter.ts`, `loader.ts`, `depth.ts`, `tool-filter.ts`, `injector.ts`, and `dispatch.ts` are pure factories — all I/O and clocks come in via injected deps. `config.ts` is a pure constants module (DEFAULT_CONFIG + CONFIG_SCHEMA).
- Tests live alongside in `test/` and run independently (`bun test`).

## Invariants

- **Registry handle is stable.** `index.ts` registers `agents:registry` once at setup with a `RegistryHandle`. Discovery mutates the inner registry via `setInner()`; consumers keep their reference. Don't replace this with re-registration.
- **Discovery is non-blocking.** `setup()` returns before discovery completes. While `ready === false`, the dispatch handler throws `Agent registry still loading; retry` — which surfaces as a tool error, not a crash. Don't await discovery in `setup()`.
- **Depth uses the turn tracker, not the bus.** Depth is computed from the in-memory `Map<turnId, TurnRecord>` walking `parentTurnId`. The driver must emit `turn:start` with the chain or depth degrades to 0. Don't try to recompute depth from event history.
- **Available-agents block flows through `prompt:registry`, not direct prompt mutation.** The section render returns `""` when the registry is empty so the assembler drops the section. Generation is bumped on every registry mutation (initial empty registry included) so the driver's per-deps assembly cache invalidates. Do not subscribe to `llm:before-call` or rewrite `request.systemPrompt` from this plugin.
- **Dispatch failures are tool errors.** Unknown agent, depth exceeded, cancellation, sub-conversation throw, and registry-not-ready all `throw` from the handler. The driver converts these to `tool:error`. Never let the plugin crash the parent turn.
- **Always-on tools are merged in, never out.** Sub-agents always see `dispatch_agent` (so they can recurse to `maxDepth`) and, if `skills:registry` is present, `load_skill`. A manifest cannot opt out.
- **Programmatic agents are namespaced.** `register()` requires the `runtime:` prefix. This keeps file-loaded and synthetic agents in disjoint namespaces.
- **Frontmatter parser is strict-subset on purpose.** Only scalars, integers, flow arrays, and `>-` folded block scalars. Don't pull in a real YAML lib — the test surface depends on the deterministic error messages.
- **Slash registration is topo-hint optional.** `slash:registry` is in `services.consumes` so kaizen orders `llm-slash-commands` first when present, but the lookup is guarded with `try`/`catch`. A harness without slash commands still boots — the dispatch tool, registry, and prompt section all work; only the `/agents:list` and `/agents:show` user-facing commands are absent.
- **Recursive walk has a depth cap.** `loader.ts` walks each scope depth-first with a hard cap of 8 levels. Entries beyond the cap emit a `directory depth exceeds 8; skipped` error and do not load. Hidden entries (names starting with `.`) are skipped entirely. This bound exists to fail loud on accidental symlink loops or misplaced agent roots.
- **Identity comes from frontmatter `name`, not path.** Two files at different paths declaring the same `name` collide; lex-first full path wins, the other emits `duplicate agent name 'X'`. Subdir layout is purely organizational.
- **Tool denylist cannot strip always-on tools.** `dispatch.ts` removes always-on tool names (`dispatch_agent`, `load_skill`) from a manifest's `excludeNames` before constructing the merged `toolFilter`. A manifest cannot opt out of these via `disallowedTools`.

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
cp -R plugins/llm-agents/. ~/.kaizen/marketplaces/official/plugins/llm-agents@0.2.1/
(cd ~/.kaizen/marketplaces/official/plugins/llm-agents@0.2.1 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
