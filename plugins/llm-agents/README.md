# llm-agents

Subagent dispatch and file-backed agent registry for the openai-compatible harness.
Discovers markdown manifests under `~/.kaizen/agents/` and `<project>/.kaizen/agents/`,
exposes `agents:registry`, and registers a `dispatch_agent` tool that recursively
invokes `driver:run-conversation` with the agent's system prompt and tool filter.
See Spec 11 for the contract.

## Sample agent

See `examples/code-reviewer.md` for a complete, working agent file. Copy it to
`~/.kaizen/agents/code-reviewer.md` to make it available across all projects, or
to `<project>/.kaizen/agents/code-reviewer.md` to make it project-scoped (which
shadows any user-scope agent of the same name).
