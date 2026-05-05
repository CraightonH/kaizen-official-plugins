# llm-codemode-dispatch

Code-mode tool dispatch strategy. The LLM writes a single TypeScript code block calling a typed `kaizen.tools.*` API, and this plugin executes it inside a Bun Worker sandbox and feeds the result back as a `[code execution result]` user message.

This is the default strategy in the C-tier harness because local LLMs are reliably better at writing a small TypeScript snippet than at emitting valid OpenAI-style `tool_calls` JSON. Approach borrowed from Cloudflare's "Code Mode".

## What it does

- Renders the registered tool list as a `.d.ts` declaration of `declare const kaizen: { tools: { ... } }` and appends it (with a preamble + example) to the system prompt for the next request.
- DTS rendering uses `json-schema-to-typescript` for parameter interfaces and is cached on a stable hash of the tool list.
- Extracts fenced ```` ```typescript ```` (and `ts`/`js`/`javascript`) blocks from the assistant message via a markdown parser, requires a properly closed fence, concatenates up to `maxBlocksPerResponse` blocks with a `\n;\n` separator, drops the rest with a notice in the feedback message.
- Wraps user code in `(async () => { ... })()`, rewrites the trailing top-level expression into a `return`, runs a forbidden-pattern lint (`import`, `import()`, `eval`, `Function`, `new Function`, `require`), and Bun-transpiles TS→JS.
- Spawns a fresh Bun `Worker` per turn, curates `globalThis` (drops `Bun`, `process`, `require`, `import`, `fetch`, network, timers other than `setTimeout`/`clearTimeout`/`queueMicrotask`), shadows non-deletable globals via `AsyncFunction` parameters, neutralizes the `Function` constructor reachable through `(()=>{}).constructor`.
- Proxies `kaizen.tools.<name>(args)` calls from the worker back to the host via `postMessage` RPC, where they invoke the tool registry. Stdout is streamed (`console.log/info/debug/warn/error`) and capped.
- Enforces `timeoutMs`, `maxStdoutBytes`, `maxReturnBytes`. On timeout, abort, or worker crash, returns a structured failure to the LLM rather than throwing to the driver. Host `AbortSignal` cancels the worker and any in-flight tool invocations.
- Formats both success and failure as a `role:"user"` message whose content begins with the literal `[code execution result]\n` prefix, followed by `exit: ok|error`, the JSON-stringified return value (with `bigint`/function/symbol/circular handling), and captured stdout.
- Emits `codemode:code-emitted`, `codemode:before-execute` (mutable payload — subscribers may rewrite `code`), and `codemode:result` or `codemode:error` around the whole block run. The tool registry emits its own per-call events; this plugin does not re-emit them.

## Wiring

### Provides

**Service** — `tool-dispatch:strategy`

Satisfies `ToolDispatchStrategy` from the `llm-events` VOCAB:

```typescript
interface ToolDispatchStrategy {
  prepareRequest(input: { availableTools: ToolSchema[] }):
    Promise<{ tools?: ToolSchema[]; systemPromptAppend?: string }>;
  handleResponse(input: {
    response: LLMResponse;
    registry: ToolsRegistryService;
    signal: AbortSignal;
    emit: (event: string, payload: unknown) => Promise<void>;
  }): Promise<ChatMessage[]>;
}
```

Semantics:
- `prepareRequest` returns only `systemPromptAppend` (the rendered DTS + preamble + example). It never sets `tools` — code-mode replaces structured tool calls.
- `handleResponse` returns `[]` when the response contains no usable code block (the driver treats that as a final answer to the user).
- When code runs, exactly one `ChatMessage` is returned: `{ role: "user", content: "[code execution result]\n..." }`.
- Render errors, sandbox timeouts, worker crashes, and code exceptions all become `exit: error` feedback messages. `AbortError` from the host signal propagates to the driver.

### Consumes

**Service** — `tools:registry` (`ToolsRegistryService`). Used inside the sandbox RPC bridge to resolve `kaizen.tools.<name>(args)` calls to real handlers. Each invocation is given a fresh `AbortController`, the host's `turnId`, and a `log` shim that forwards to `status:item-update` with key `tool:<callId>`.

The driver passes the registry into `handleResponse`; the strategy itself does not look it up via `useService`.

### Events emitted

All payloads are passed through the `emit` callback supplied by the driver (`llm-events` VOCAB).

- `codemode:code-emitted` — `{ code: string; language: "typescript" }`. Fired after extraction, before any execution, with the concatenated source.
- `codemode:before-execute` — `{ code: string }`. Mutable. Subscribers may rewrite `code` (e.g. redaction, policy block via `throw new Error("blocked")`); the post-await value is what runs.
- `codemode:result` — `{ stdout: string; returnValue: unknown }`. Successful run.
- `codemode:error` — `{ message: string }`. Sandbox-reported failure (transpile error, runtime throw, timeout, worker crash). The driver still receives a feedback `ChatMessage`; this event is for observers.
- `status:item-update` — `{ key: "tool:<callId>"; value: string }`. Forwarded from the per-tool `log` channel during nested tool invocations.

This plugin does not call `defineEvent`; the event names are owned by the `llm-events` VOCAB.

## Configuration

Loaded once at `setup()` from a JSON file. Missing file → defaults. Malformed JSON or invalid values → throw.

| Setting | Default | Effect |
|---------|---------|--------|
| `timeoutMs` | `30000` | Per-turn sandbox wall clock. Exceeding emits `TimeoutError` to the LLM. |
| `maxStdoutBytes` | `16384` | Hard cap on captured stdout; overflow truncated with `...[truncated, N more bytes]`. |
| `maxReturnBytes` | `4096` | Cap on the JSON-stringified return value in feedback. |
| `maxBlocksPerResponse` | `8` | Code blocks beyond this are dropped; LLM is told how many were ignored. |
| `sandbox` | `"bun-worker"` | Only legal value today. |

Path resolution:
- Default: `~/.kaizen/plugins/llm-codemode-dispatch/config.json`
- Override: `KAIZEN_LLM_CODEMODE_CONFIG=<path>` (logged as a warning if the override path is missing; default-path missing is silent).

## Permissions

`tier: unscoped` — needs to spawn a `Worker` and run arbitrary user-authored code in it.
