# llm-driver

Coordination plugin for the openai-compatible harness. Owns the assistant turn
loop, the in-memory transcript, cancellation, and the lifecycle events from
Spec 0 (`turn:*`, `conversation:*`, `llm:*`). Consumes `llm:complete` for the
provider call and optionally `tools:registry` + `tool-dispatch:strategy` for
multi-step tool flows. Provides `driver:run-conversation` so other plugins
(notably `llm-agents`) can recursively run nested conversations as child turns.
