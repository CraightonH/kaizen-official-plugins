# kaizen-official-plugins

Official kaizen plugin marketplace. Hosts plugins and harnesses for [kaizen](https://github.com/CraightonH/kaizen) 0.3+.

## Plugins

### Foundation

- **llm-events** — event vocabulary and shared types for openai-compatible harnesses.
- **openai-llm** — OpenAI-compatible LLM provider. Provides `llm:complete`. Configure at `~/.kaizen/plugins/openai-llm/config.json`; see the plugin's README for the schema.

### Tools

- **llm-tools-registry** — central tool registry and single tool-execution chokepoint. Provides `tools:registry`.
- **llm-local-tools** — built-in local-development toolset (`read_file`, `write_file`, `create_file`, `edit_file`, `glob`, `grep`, `bash`). NOT sandboxed.
- **llm-mcp-bridge** — bridges MCP servers (tools + resources) into the tools registry. Configure servers at `~/.kaizen/mcp/servers.json`.
- **llm-native-dispatch** — native OpenAI tool-calling dispatch strategy (`tool_calls` JSON).
- **llm-codemode-dispatch** — code-mode dispatch: LLM writes TypeScript calling `kaizen.tools.*` in a Bun Worker sandbox. Default strategy for local LLMs.

### Conversation

- **llm-driver** — turn loop and conversation state for openai-compatible harnesses. Provides `driver:run-conversation`.
- **llm-skills** — skills registry and file-loader for `~/.kaizen/skills/` and `<project>/.kaizen/skills/`. Injects skills into the system prompt.
- **llm-memory** — file-backed persistent memory. Provides `memory:store`, `memory_recall`/`memory_save` tools, and `llm:before-call` injection.
- **llm-agents** — subagent dispatch and file-loader for `~/.kaizen/agents/`. Provides `dispatch_agent` tool.
- **llm-slash-commands** — slash command registry, dispatcher, and markdown file-loader. Built-ins: `/help`, `/exit`.

### UI

- **llm-tui** — generic LLM-chat TUI: input box, output pane, status bar, completion popup, theme system. Backs the `openai-compatible` harness.

### Optional

- **llm-status-items** — status-bar items for model, token count, cost, and turn state.
- **llm-hooks-shell** — optional shell-command hooks for harness events (audit, blocking gates, notifications).

### Claude-specific

- **claude-events** — event vocabulary for the claude-wrapper harness.
- **claude-tui** — terminal UI: rounded "kaizen" prompt box + status bar. Provides `ui:channel`. Backs the `claude-wrapper` harness.
- **claude-status-items** — emits `cwd` and `git.branch` status items.
- **claude-driver** — session driver; wraps the local `claude` CLI in headless stream-json mode.

## Harnesses

- **claude-wrapper** — Claude Code wrapper UI over `claude -p`. Requires the `claude` binary on `$PATH` and an authenticated Claude Code login (Pro/Max/Team/Enterprise OAuth, or API key).
- **openai-compatible** — chat with any OpenAI-compatible LLM endpoint (LM Studio, Ollama, vLLM, llama.cpp, hosted providers). No `claude` binary required. Configuration lives in `~/.kaizen/plugins/openai-llm/config.json`.

### Choosing a harness

- Use **claude-wrapper** if you have a Claude Code login and want the existing Claude UX over `claude -p`.
- Use **openai-compatible** for everything else: local LLMs (LM Studio, Ollama, vLLM) and any third-party OpenAI-compatible endpoint.

## Usage

```sh
kaizen --harness official/claude-wrapper@0.1.0
```

Or run from a local checkout:

```sh
kaizen --harness ./harnesses/claude-wrapper.json
```

For the OpenAI-compatible harness:

```sh
kaizen --harness official/openai-compatible@0.1.0
```

Or run from a local checkout:

```sh
kaizen --harness ./harnesses/openai-compatible.json
```

## Layout

```
.
├── .kaizen/
│   └── marketplace.json      # catalog: plugin + harness entries
├── plugins/
│   ├── llm-events/           # event vocab + shared types (Spec 0)
│   ├── openai-llm/           # LLM provider (llm:complete)
│   ├── llm-tools-registry/   # tool registry (tools:registry)
│   ├── llm-local-tools/      # built-in filesystem + shell tools
│   ├── llm-mcp-bridge/       # MCP server bridge
│   ├── llm-native-dispatch/  # OpenAI native tool-calling strategy
│   ├── llm-codemode-dispatch/# code-mode tool dispatch (default)
│   ├── llm-driver/           # turn loop (driver:run-conversation)
│   ├── llm-skills/           # skills registry + loader
│   ├── llm-memory/           # persistent memory
│   ├── llm-agents/           # subagent dispatch
│   ├── llm-slash-commands/   # slash command registry
│   ├── llm-tui/              # TUI (Ink + React)
│   ├── llm-status-items/     # optional status bar items
│   ├── llm-hooks-shell/      # optional shell hooks
│   ├── claude-events/
│   ├── claude-tui/
│   ├── claude-status-items/
│   └── claude-driver/
└── harnesses/
    ├── claude-wrapper.json
    └── openai-compatible.json
```

## Development

```sh
bun install
bun test
```

## Contributing a plugin

1. Scaffold: `kaizen plugin create plugins/<name>`.
2. Implement against `kaizen/types`. Tests, README, permissions, `public.d.ts`.
3. Validate: `kaizen plugin validate plugins/<name>`.
4. Add an entry under `.kaizen/marketplace.json#entries`.
5. Open a PR.

## Standards

See [`docs/reference/plugin-standards.md`](https://github.com/CraightonH/kaizen/blob/master/docs/reference/plugin-standards.md) in the kaizen repo.
