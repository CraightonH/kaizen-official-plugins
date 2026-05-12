# llm-events Contract Change

Date: 2026-05-12
Session target: llm-events

## Summary

`llm-events/public.d.ts` no longer aggregates owner-specific service contracts.
It now exposes only event vocabulary, foundation LLM/message/tool primitives,
`LLMCompleteService`, and the shared runtime sentinels. The runtime event
vocabulary did not change.

## Previous Contract

- Owner: `llm-events` exposed both foundation primitives and deprecated
  compatibility declarations for services owned by peer plugins.
- Consumers: openai-compatible `llm-*` plugins could import service contracts
  from `llm-events/public`.
- Service/event/tool/type/config surface: compatibility declarations for
  `tools:registry`, `tool-dispatch:strategy`, `skills:registry`,
  `agents:registry`, `slash:registry`, and `llm-tui:completion`.
- Old behavior or shape: owner-specific contracts remained importable from
  `llm-events/public` even after each owner plugin exposed its own `public`
  subpath.

## New Contract

- New behavior or shape: `llm-events/public` keeps `Vocab`, `EventName`,
  `ChatMessage`, `ToolCall`, `ToolSchema`, `ModelInfo`, `LLMRequest`,
  `LLMResponse`, `LLMStreamEvent`, `LLMCompleteService`, `CANCEL_TOOL`, and
  `CODEMODE_CANCEL_SENTINEL`. It removes service contracts and their payload
  helper types.
- Compatibility notes: this is a breaking type-surface cleanup published as
  `llm-events@0.7.0`. Runtime event names and sentinel values are unchanged.
- Migration required by consumers: import service contracts from their owners:
  `llm-tools-registry/public`, `llm-driver/public`, `llm-skills/public`,
  `llm-agents/public`, `llm-slash-commands/public`, and `llm-tui/public`.

## Affected OpenAI-Compatible Plugins

- `llm-tools-registry`: owner for tools registry contracts; verified compatible.
- `llm-driver`: owner for driver and dispatch strategy contracts; verified
  compatible.
- `llm-native-dispatch`: imports dispatch contract from `llm-driver/public`;
  verified compatible.
- `llm-skills`: owner for skills registry contracts; verified compatible.
- `llm-agents`: owner for agents registry contracts; verified compatible.
- `llm-slash-commands`: owner for slash registry contracts; verified compatible.
- `llm-tui`: owner for completion contracts; verified compatible.
- Other openai-compatible plugins: verified by grep to import only foundation
  types from `llm-events/public` or owner service contracts from owner packages.

## Verification

- Tests run: `bun install --frozen-lockfile`; `bun test plugins/llm-events`;
  `bun test`; `bunx kaizen plugin validate plugins/llm-events`; `bunx kaizen
  marketplace validate`.
- Tests not run and why: live integration tests gated by local services or
  environment, such as LM Studio and MCP server integration, were not enabled
  and were reported as skipped by `bun test`.
