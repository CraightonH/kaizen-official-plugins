# llm-memory Contract Change

Date: 2026-05-13
Session target: llm-memory

## Summary

Narrowed `services.consumes` to only `llm-events:vocabulary` and aligned
runtime behavior with that declaration. The plugin previously listed
`prompt:system`, `tools:registry`, and `driver:run-conversation` in `consumes`
even though all three are resolved lazily with `ctx.useService` and the plugin
already degrades gracefully when any are absent (warns/logs, then continues).
Per `AGENTS.md` ("Use `services.consumes` and `ctx.consumeService()` only for
hard requirements"), these belong out of the hard-consume manifest.

Also added a `./public` entry to `package.json#exports` so peers can import
`MemoryStoreService` and friends via `llm-memory/public` (mirrors the pattern
used by other openai-compatible plugins). Added `stop()` lifecycle to
unregister the `prompt:system` section and the two tools so plugin reload is
clean.

## Previous Contract

- Owner: `llm-memory` (manifest-level dependency declaration).
- Consumers: Kaizen runtime (plugin loader / dep resolver).
- Service/event/tool/type/config surface: `KaizenPlugin.services.consumes`.
- Old behavior or shape:
  - `consumes: ["llm-events:vocabulary", "tools:registry", "driver:run-conversation", "prompt:system"]`
  - Plugin tier: `unscoped`. Code: still resolved all three with
    `ctx.useService` and tolerated absence.

## New Contract

- New behavior or shape:
  - `consumes: ["llm-events:vocabulary"]`
  - Optional services (`prompt:system`, `tools:registry`,
    `driver:run-conversation`) continue to be probed via `ctx.useService` with
    clear log/emit when missing. Behavior is unchanged when the services are
    present; the only difference is that the harness no longer treats their
    absence as a hard load failure.
  - `package.json#exports` now also exposes `./public` →
    `./public.d.ts`. No code change; existing source imports already use the
    `public.d.ts` path.
  - New optional `stop()` hook unregisters the `prompt:system` section handle
    and the two tool registrations. Both unregister calls are idempotent.
- Compatibility notes:
  - Existing harnesses that include `llm-memory` continue to work. The
    openai-compatible harness already ships with all three optional services,
    so no observable behavioral change there.
  - Loosens the load order: harnesses that omit `prompt:system` or
    `tools:registry` no longer error at load — memory simply degrades. This
    matches what the README/code already described.
- Migration required by consumers: none. The plugin's *public* contract
  (`memory:store` service shape, `memory_recall` / `memory_save` schemas,
  `prompt:system` section id/priority) is unchanged.

## Affected OpenAI-Compatible Plugins

- `llm-system-prompt`: verified compatible (provides `prompt:system`).
- `llm-tools-registry`: verified compatible (provides `tools:registry`).
- `llm-driver`: verified compatible (provides `driver:run-conversation`).
- All others: not affected (no direct dependency on `llm-memory`).

## Verification

- Tests run:
  - `bun test plugins/llm-memory` — 87 pass / 0 fail.
  - `bun test plugins/llm-system-prompt plugins/llm-driver` — 80 pass / 0 fail.
  - `bunx tsc -p plugins/llm-memory/tsconfig.json --noEmit` — clean.
- Tests not run and why: no live integration tests required — change is
  manifest + lifecycle only; no service shape changes.
