# llm-local-tools Contract Change

Date: 2026-05-13
Session target: llm-local-tools

## Summary

`llm-local-tools` previously returned `{ teardown }` from `setup()`, relying on a non-standard
runtime convention. The Kaizen plugin contract types `setup(ctx) => Promise<void>` and uses a
separate `stop?(ctx) => Promise<void>` hook for cleanup. The Kaizen runtime never invoked the
returned teardown — tools registered on plugin reload were never unregistered, leaking
duplicate registrations on hot-reload.

This session converts the plugin to the canonical `stop()` hook (same pattern as
`llm-status-items`).

## Previous Contract

- Owner: `llm-local-tools`
- Consumers: None at runtime — only test code asserted the teardown shape.
- Service/event/tool/type/config surface: `setup()` returned `{ teardown(): Promise<void> }`.
- Old behavior or shape: Tools registered with `tools:registry`; unregisters collected in an
  array; teardown drained the array. Runtime never called teardown.

## New Contract

- New behavior or shape: `setup(ctx) => Promise<void>` (matches `KaizenPlugin.setup`).
  `stop(ctx) => Promise<void>` drains the unregister array. The runtime now correctly removes
  every tool when the plugin is unloaded or hot-reloaded.
- Compatibility notes: Public LLM-facing surface (the eight tools) is unchanged. Tag tuples
  unchanged. Tool schemas unchanged. Only the plugin lifecycle hook moved.
- Migration required by consumers: None for the LLM/runtime surface. Test fixtures that called
  `(await plugin.setup(ctx)).teardown()` must call `plugin.stop!(ctx)` instead. Updated in this
  session in `test/scaffold.test.ts` and `test/integration.test.ts`.

## Affected OpenAI-Compatible Plugins

- llm-local-tools: bumped 0.1.0 → 0.2.0. `.kaizen/marketplace.json` and
  `harnesses/openai-compatible.json` coordinates updated.
- All other harness plugins: verified compatible — they import `TOOL_NAMES` / `ToolSchema` /
  `ToolCall` from `llm-local-tools/public` (none currently do) or interact only via the shared
  `tools:registry`. No source edits required.

## Verification

- Tests run:
  - `bun test plugins/llm-local-tools` — 90 pass, 5 skip (ripgrep-path tests gated on rg
    availability in the spawn PATH); 0 fail.
  - `bunx tsc -p plugins/llm-local-tools/tsconfig.json --noEmit` — clean.
- Tests not run and why: Full repo `bun test` not run — the lifecycle change is local and other
  plugins do not depend on this plugin's `setup` return shape.
