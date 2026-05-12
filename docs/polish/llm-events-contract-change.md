# llm-events Contract Change

Date: 2026-05-12
Session target: llm-events

## Summary

`llm-events/public.d.ts` now matches the already-refactored owner plugins for
shared service declarations. The runtime event vocabulary did not change.

## Previous Contract

- Owner: `llm-events` for shared declarations; runtime service behavior owned by
  each provider plugin.
- Consumers: openai-compatible `llm-*` plugins importing `llm-events/public`.
- Service/event/tool/type/config surface: `tools:registry`, `skills:registry`,
  `slash:registry`, `llm-tui:completion`, `tool-dispatch:strategy`, and package
  subpath export metadata.
- Old behavior or shape: `llm-events/public.d.ts` described older service
  shapes, including no tool provenance APIs, `skills.rescan(): Promise<void>`,
  slash `tryDispatch`, `SlashCommandManifest.source` values of
  `"builtin" | "user" | "project" | "plugin"`, and a completion source shaped as
  `list(input, cursor)`.

## New Contract

- New behavior or shape: shared declarations now include tool provenance
  (`ToolSource`, `ToolRegistration`, `registerWith`, `listRegistrations`),
  `SkillRescanResult`, current slash registry `get`/`register`/`list` shapes,
  current TUI completion `id`/`trigger`/`list(query)` shape, and an exported
  `./public` package subpath.
- Compatibility notes: runtime behavior was already provided by owner plugins;
  this change aligns the foundation type contract with that behavior.
- Migration required by consumers: consumers typed against the stale slash
  `tryDispatch` contract or old completion `(input, cursor)` contract must
  migrate to the current owner-plugin APIs.

## Affected OpenAI-Compatible Plugins

- `llm-tools-registry`: verified compatible; owner already exposes provenance.
- `llm-skills`: verified compatible; owner already returns rescan metadata.
- `llm-slash-commands`: verified compatible; owner already exposes `get` and
  file-backed manifest metadata.
- `llm-tui`: verified compatible; owner already uses `id`, string `trigger`,
  and `list(query)`.
- `llm-driver` / `llm-native-dispatch`: verified compatible with the
  `ToolDispatchStrategy` declaration.

## Verification

- Tests run: `bun test plugins/llm-events`; affected consumer tests for
  tools-registry, skills, slash-commands, TUI completion, driver/native dispatch
  compatibility; `plugins/llm-events/node_modules/.bin/tsc -p
  plugins/llm-events/tsconfig.json`; `bunx kaizen plugin validate
  plugins/llm-events`; `bunx kaizen marketplace validate`; `bun test`.
- Tests not run and why: live integration tests gated by `KAIZEN_INTEGRATION=1`
  were not enabled.
