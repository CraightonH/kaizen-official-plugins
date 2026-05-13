# llm-driver Contract Change

Date: 2026-05-11
Session target: llm-driver

## Summary

`llm-driver` now owns the `driver:run-conversation` TypeScript contract. The
duplicated `DriverService`, `RunConversationInput`, and `RunConversationOutput`
exports were removed from `llm-events/public.d.ts` so `llm-events` can remain a
dependency-free foundation package.

## Previous Contract

- Owner: ambiguous; `llm-driver/public.d.ts` and `llm-events/public.d.ts` both
  exported equivalent `driver:run-conversation` service types.
- Consumers: `llm-agents` imported the driver service contract from
  `llm-events/public`.
- Service/event/tool/type/config surface: TypeScript service types for
  `driver:run-conversation`.
- Old behavior or shape: the type shape matched the driver API but lived in two
  places, with the `llm-events` copy requiring a type import from
  `llm-session-manager/public`.

## New Contract

- New behavior or shape: `llm-driver/public.d.ts` is the only exported owner for
  `DriverService`, `RunConversationInput`, and `RunConversationOutput`.
- Compatibility notes: the runtime service name and payload shape are unchanged.
  The breaking change is import-path-only for consumers that imported driver
  types from `llm-events/public`.
- Migration required by consumers: import driver service types from
  `llm-driver/public`.

## Affected OpenAI-Compatible Plugins

- `llm-events`: removed the duplicate driver contract and dependency on
  `llm-session-manager/public`.
- `llm-driver`: internal loop now imports the public driver contract from its
  own `public.d.ts`.
- `llm-agents`: updated driver contract imports to `llm-driver/public`.

## Verification

- Tests run: `bun test plugins/llm-events`; `bun test plugins/llm-driver`;
  `bun test plugins/llm-agents`; `kaizen plugin validate plugins/llm-events`;
  `kaizen plugin validate plugins/llm-driver`; `kaizen plugin validate
  plugins/llm-agents`; `kaizen marketplace validate .`; `bun test`.
- Tests not run and why: full installed-harness smoke has not completed yet; a
  local source harness attempt reached plugin permission consent before runtime
  startup. The next step is to pre-seed scoped consent for the local harness or
  validate through the pushed marketplace path with a rollback-ready commit.
