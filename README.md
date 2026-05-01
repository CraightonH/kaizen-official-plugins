# kaizen-official-plugins

Official kaizen plugin marketplace. Hosts plugins and harnesses for [kaizen](https://github.com/CraightonH/kaizen) 0.3+.

## Plugins

- **claude-events** — event vocabulary for the claude-wrapper harness.
- **claude-tui** — terminal UI: rounded "kaizen" prompt box + status bar. Provides `ui:channel`. Backs the `claude-wrapper` harness.
- **claude-status-items** — emits `cwd` and `git.branch` status items.
- **claude-driver** — session driver; wraps the local `claude` CLI in headless stream-json mode.
- **llm-events** — event vocabulary and shared types for openai-compatible harnesses.
- **openai-llm** — OpenAI-compatible LLM provider. Provides `llm:complete`. Configure at `~/.kaizen/plugins/openai-llm/config.json`; see the plugin's README for the schema.
- **llm-driver** — turn loop and conversation state for openai-compatible harnesses. Provides `driver:run-conversation`.
- **llm-tui** — generic LLM-chat TUI primitives (input, output, status bar, completion popup, theme). Distinct from `claude-tui`; backs the `openai-compatible` harness and any future LLM harnesses.

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
│   ├── claude-events/
│   ├── claude-tui/
│   ├── claude-status-items/
│   ├── claude-driver/
│   ├── llm-events/
│   ├── openai-llm/
│   ├── llm-driver/
│   └── llm-tui/
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
