# llm-native-dispatch

Native OpenAI tool-calling dispatch strategy. Provides the
`tool-dispatch:strategy` service: `prepareRequest` passes registered tool
schemas straight through to the LLM request; `handleResponse` walks any
`response.toolCalls` sequentially, executes each via `registry.invoke`, and
returns `[assistantMessage, ...toolMessages]` so the driver's loop can
continue. Errors become tool messages, never thrown exceptions, so a single
bad tool call does not kill the conversation.
