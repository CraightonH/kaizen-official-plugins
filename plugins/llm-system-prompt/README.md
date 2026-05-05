# llm-system-prompt

Owns construction of the assistant's system prompt for the openai-compatible harness.

- Provides the `prompt:system` service: a registry where peers register named, prioritized sections.
- Owns the `identity` section sourced from `~/.kaizen/system-prompt.md` (global) merged with `<project>/.kaizen/system-prompt.md` (project override under a `## Project context` header). Falls back to a built-in default if neither exists.
- Emits `prompt:rebuilt` whenever the assembly changes; `llm-driver` consumes this to invalidate its cached prompt.
- Registers slash commands: `/prompt:show`, `/prompt:reload`, `/prompt:disable`, `/prompt:enable`.

See `docs/superpowers/specs/2026-05-04-llm-system-prompt-design.md` (Spec 14) for the full contract.
