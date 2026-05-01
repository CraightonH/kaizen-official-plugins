# llm-tools-registry

Central tool registry for the openai-compatible harness. Provides the
`tools:registry` service: any plugin may `register(schema, handler)` and any
consumer (driver, dispatch strategy, agent) may `list()` / `invoke()`. The
registry is the single place that emits `tool:before-execute`, `tool:execute`,
`tool:result`, and `tool:error` so observability is uniform regardless of
which dispatch strategy is active. In-memory only; plugins re-register on
every `setup`.
