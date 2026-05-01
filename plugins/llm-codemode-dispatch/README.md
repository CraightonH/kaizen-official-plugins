# llm-codemode-dispatch

Default tool-dispatch strategy for the openai-compatible harness. Instead of asking
the LLM to emit OpenAI-style structured `tool_calls` JSON, this plugin gives the
LLM a typed `kaizen.tools.*` TypeScript API (rendered as `.d.ts` from each tool's
JSON Schema), extracts fenced ` ```typescript ` blocks from the response, and
executes them in a Bun Worker sandbox whose tool calls proxy back to
`tools:registry` over `postMessage` RPC.

Local LLMs (Llama, Qwen, Mistral classes) are notably worse at OpenAI tool-call
JSON than they are at writing small TypeScript snippets, so code mode is the
default for the C-tier harness.

## Sandboxing

The sandbox is a Bun Worker with a curated `globalThis` (no `Bun`, `process`,
`require`, `fetch`, `setInterval`, dynamic `import()`, `eval`, `Function`).
Wall-clock timeout (default 30s) is enforced via `worker.terminate()`.
`AbortSignal` aborts the worker and any in-flight tool calls. This is sufficient
for the documented threat model (the LLM is unreliable, not adversarial). For an
adversarial threat model, see the deferred `codemode.sandbox = "quickjs"` toggle.

## Config

`~/.kaizen/plugins/llm-codemode-dispatch/config.json`:

| Key | Default |
|---|---|
| `timeoutMs` | `30000` |
| `maxStdoutBytes` | `16384` |
| `maxReturnBytes` | `4096` |
| `maxBlocksPerResponse` | `8` |
| `sandbox` | `"bun-worker"` |

Override config path via `KAIZEN_LLM_CODEMODE_CONFIG`.
