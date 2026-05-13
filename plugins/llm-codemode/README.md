# llm-codemode

Registers `execute_typescript` as a single tool with `tools:registry`. The LLM invokes it through standard OpenAI tool-calling; the handler runs the code in a Bun Worker sandbox and returns the structured result as the tool message content.

## What it provides

- One tool registration: `execute_typescript({ code: string })`.
- A TUI renderer (registered with `ui:tool-renderer` if available) that displays the code, stdout, and result inline.
- A `tool:progress` event emitted from the sandbox host while user code writes to stdout.

## Dependencies

- Required: `tools:registry` (from `llm-tools-registry`). Without it, the plugin logs and no-ops at setup.
- Optional: `ui:tool-renderer` (from `llm-tui`). When present, an inline renderer for `execute_typescript` is registered; when absent, the plugin runs normally with no inline UI.

## Relationship to `dispatch:strategy`

`llm-codemode` is a **tool-registration plugin**, not a dispatch strategy. It registers a single tool (`execute_typescript`) into `tools:registry` exactly like `llm-local-tools` or any other tool provider. It does not call `ctx.provideService("dispatch:strategy", ...)` and carries no `services.provides` entry.

The `dispatch:strategy` contract is cardinality-one: exactly one plugin provides it per harness. That role belongs to `llm-native-dispatch`. Once `llm-native-dispatch` provides the strategy, every registered tool — including `execute_typescript` — is dispatched through the standard sequential loop in `strategy.ts`. The two plugins are **orthogonal** and must both appear in the harness manifest; removing either breaks different things (`llm-native-dispatch` → no tool dispatch at all; `llm-codemode` → no sandboxed code execution tool).

## What it doesn't do

- Does not provide `dispatch:strategy`. The harness's dispatch strategy (`llm-native-dispatch`) consumes this tool like any other.
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
