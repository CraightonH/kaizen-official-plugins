# llm-tui

Generic LLM chat TUI for the openai-compatible harness. Provides four services:
`llm-tui:channel` (pull-style chat I/O), `llm-tui:completion` (registerable
completion popup), `llm-tui:status` (marker; subscribes to status events),
`llm-tui:theme` (read-only theme tokens). Emits one event into the bus:
`input:submit`. NOT a fork of `claude-tui` — fresh extraction with no
slash-command, MCP, or skills coupling.
