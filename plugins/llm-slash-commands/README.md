# llm-slash-commands

Slash-command dispatcher for the openai-compatible harness. Subscribes to
`input:submit`, parses `/<name> [args]`, dispatches to a registered handler.
Provides the `slash:registry` service so other plugins can register namespaced
commands (`mcp:reload`, `skills:list`, etc.). Bare names are reserved for
built-ins (`/help`, `/exit`), driver-coupled commands (`/clear`, `/model`,
registered by `llm-driver`), and user/project markdown files in
`~/.kaizen/commands/` and `<project>/.kaizen/commands/`.
