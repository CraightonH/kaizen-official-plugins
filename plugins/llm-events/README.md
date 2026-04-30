# llm-events

Event vocabulary and shared types for the openai-compatible harness ecosystem.
Provides the `llm-events:vocabulary` service whose value is a frozen `VOCAB`
constant, calls `ctx.defineEvent` for each name, and exports the Spec 0 shared
types (`ChatMessage`, `ToolCall`, `LLMRequest`, etc.) from `public.d.ts`.
