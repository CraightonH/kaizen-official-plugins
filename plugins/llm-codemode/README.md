# llm-codemode

Registers `execute_typescript` as a single tool with `tools:registry`. The LLM invokes it through standard OpenAI tool-calling; the handler runs the code in a Bun Worker sandbox and returns the structured result as the tool message content.

## What it provides

- One tool registration: `execute_typescript({ code: string })`.
- A TUI renderer (registered with `llm-tui:tool-renderer` if available) that displays the code, stdout, and result inline.
- A `tool:progress` event emitted from the sandbox host while user code writes to stdout.

## Dependencies

- Required: `tools:registry` (from `llm-tools-registry`). Without it, the plugin logs and no-ops at setup.
- Optional: `llm-tui:tool-renderer` (from `llm-tui`). When present, an inline renderer for `execute_typescript` is registered; when absent, the plugin runs normally with no inline UI.

## What it doesn't do

- Does not provide `tool-dispatch:strategy`. The harness's dispatch strategy (`llm-native-dispatch`) consumes this tool like any other.
- Does not modify the system prompt. The `kaizen.*` API surface is taught via the tool's `description` field.
- Does not parse code out of assistant prose. The LLM emits `tool_calls` with the code as the `code` argument.

## Configuration

`~/.kaizen/plugins/llm-codemode/config.json` (override via `KAIZEN_LLM_CODEMODE_CONFIG`):

| Key | Default | Description |
| --- | --- | --- |
| `timeoutMs` | 30000 | Sandbox execution timeout (ms). |
| `maxStdoutBytes` | 16384 | Cap on captured stdout (bytes). |
| `maxReturnBytes` | 4096 | Cap on returned-value serialization length (bytes). |
| `sandbox` | `"bun-worker"` | Sandbox backend. Only `bun-worker` is supported today. |

Unknown keys in `config.json` are silently ignored. The previous
`maxBlocksPerResponse` key was reserved and never consulted; it was removed in
0.3.0. Existing configs that set it continue to load without error.
