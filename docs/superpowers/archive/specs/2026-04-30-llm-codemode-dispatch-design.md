# `llm-codemode-dispatch` — Code-Mode Tool Dispatch (Spec 5)

**Status:** draft
**Date:** 2026-04-30
**Tier:** 2 (B milestone — tool calls)
**Depends on:** Spec 0 (`2026-04-30-openai-compatible-foundation-design.md`), Spec 4 (`llm-tools-registry`)
**Provides service:** `tool-dispatch:strategy`
**Consumes service:** `tools:registry`
**Permissions:** `unscoped`

## Goal

Provide a `ToolDispatchStrategy` that turns the LLM's text output into executable tool invocations by giving the LLM a typed TypeScript API and letting it write code, instead of asking it to emit OpenAI-style structured tool-call JSON.

This plugin is the **default** dispatch strategy in the C-tier harness because local LLMs (Llama-class, Qwen-class, Mistral-class) are reliably worse at emitting valid `tool_calls` JSON than they are at writing a small block of TypeScript that does the same thing. The approach is borrowed from Cloudflare's "Code Mode" (https://blog.cloudflare.com/code-mode/).

## Non-goals

- Hosting a general-purpose JavaScript runtime. The sandbox exists to drive a known, finite tool surface; programs that ignore that surface and try to compute things from scratch are out of scope and will be killed by timeout.
- Replacing native dispatch. `llm-native-dispatch` ships in the same tier and remains the right choice for frontier models with strong tool-call training.
- Loading user-authored skills/plugins inside the sandbox. Tool registration happens outside; the sandbox only *calls* tools.
- Multi-step planning or autonomous loops *inside one code block*. A code block is one LLM "tool turn"; multi-step reasoning is handled by the driver's outer turn loop, not by clever scripting in the sandbox.

## Architectural overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│ llm-driver                                                              │
│                                                                         │
│  prepareRequest({ availableTools }) ──────► systemPromptAppend (.d.ts)  │
│  call llm:complete                                                      │
│  handleResponse({ response, registry, signal, emit })                   │
│      │                                                                  │
│      ▼                                                                  │
└──────┼──────────────────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────────────────┐
│ llm-codemode-dispatch (this plugin)                                     │
│                                                                         │
│   ┌────────────────────┐    ┌──────────────────┐                        │
│   │ DTS renderer       │    │ Code extractor   │                        │
│   │ (JSONSchema7→.d.ts)│    │ (fenced-block re)│                        │
│   └─────────┬──────────┘    └─────────┬────────┘                        │
│             │ used by prepareRequest  │ used by handleResponse          │
│             ▼                         ▼                                 │
│   ┌────────────────────────────────────────────────┐                    │
│   │ Sandbox host                                   │                    │
│   │   spawns Bun Worker, exposes `kaizen.tools.*`  │                    │
│   │   marshals postMessage RPC ──────────────────┐ │                    │
│   │                                              │ │                    │
│   └──────────────────────────────────────────────┼─┘                    │
│                                                  │                      │
└──────────────────────────────────────────────────┼──────────────────────┘
                                                   │
                                                   ▼
                                       tools:registry.invoke(name,args,ctx)
```

`prepareRequest` produces a `systemPromptAppend` containing a `.d.ts` describing the available tools and a brief instruction block. It does **not** populate `tools` — that field is reserved for native dispatch.

`handleResponse` extracts fenced TypeScript/JavaScript code blocks from the assistant's text, runs them in a Bun Worker sandbox whose `globalThis.kaizen.tools` proxies into `registry.invoke`, and surfaces the captured stdout + return value back into the conversation as a synthetic `user`-role feedback message.

## Service contract

This plugin provides exactly one service: `tool-dispatch:strategy`, satisfying `ToolDispatchStrategy` from Spec 0:

```ts
provide("tool-dispatch:strategy", {
  prepareRequest({ availableTools }) { /* ... */ },
  async handleResponse({ response, registry, signal, emit }) { /* ... */ },
});
```

When both `llm-codemode-dispatch` and `llm-native-dispatch` are loaded, the harness file selects which one wins by listing it in the harness manifest's plugin order and giving it precedence in service resolution. (Service resolution rules are owned by Spec 0 and the kaizen core; this plugin does not negotiate.)

## `prepareRequest`

### Signature recap

```ts
prepareRequest(input: { availableTools: ToolSchema[] })
  : { tools?: ToolSchema[]; systemPromptAppend?: string }
```

This plugin returns `{ systemPromptAppend }` only. `tools` is left undefined.

### Output shape

`systemPromptAppend` is a single string with three sections, separated by blank lines:

1. **Preamble** — short natural-language instructions explaining how code mode works.
2. **`.d.ts` block** — a fenced ``typescript`` block declaring the `kaizen` global.
3. **Output contract** — a few-shot example showing exactly one ``typescript`` fenced block being the desired output.

A representative rendering (illustrative — exact wording may shift during implementation, but the structure is fixed):

```
You have access to a sandboxed TypeScript runtime. To use a tool, write a
single ```typescript code block. The code is executed in order; the value
of the last expression (or any explicit `return` from a top-level async IIFE)
is returned to you as the tool result. Use `console.log` to surface
intermediate output. Only one ```typescript block per turn will be executed;
if you write none, your reply is treated as a final answer to the user.

The following API is available:

```typescript
declare const kaizen: {
  tools: {
    /** Read a file from disk. */
    readFile(args: { path: string }): Promise<string>;
    /** ... */
  };
};
```

Example:
```typescript
const contents = await kaizen.tools.readFile({ path: "/etc/hostname" });
console.log("read", contents.length, "bytes");
contents;
```
```

### Namespace decision: `kaizen.tools.<name>`

Decision: expose tools at `kaizen.tools.<toolName>(args)`, not as a flat `tools` global, not as bare functions.

Rationale:

- A single namespace prevents collisions with anything we expose later (`kaizen.console`, `kaizen.env`, `kaizen.cancel`, etc.).
- `kaizen.tools.X(args)` reads naturally and matches the registry's mental model.
- A flat global (`readFile(...)`) would shadow user code that happens to declare a local `readFile`, and would force every tool name into the global identifier space (some tool names are not valid identifiers — e.g. `web-search` — and would need rewriting; namespacing under an object lets us use bracket access internally if needed and dotted access in the typical case).
- Tool names that are not valid TS identifiers (`web-search`, `kebab-case`) are rendered with bracket-property syntax in the `.d.ts` (`"web-search"(args: ...): Promise<...>`). The sandbox host exposes them under the same key.

### Tool-name → method mapping

Every `ToolSchema.name` from `availableTools` becomes one method on `kaizen.tools`. Method signature:

```ts
<name>(args: <ParamsType>): Promise<unknown>
```

Where `<ParamsType>` is derived from the schema's `parameters` (JSONSchema7) by the DTS renderer described below. Return type is `Promise<unknown>` because the registry contract returns `Promise<unknown>`; we deliberately do not over-promise a typed return.

JSDoc on each method is `description` from the schema. If the schema lacks a description, no JSDoc is emitted.

### Tool filtering

`prepareRequest` is given a pre-filtered `availableTools` list by the driver (the driver applies any `toolFilter` from `RunConversationInput`). This plugin does not re-filter and does not call `registry.list` directly — that would create a TOCTOU between request-prep and response-handling.

The same list must be passed to `handleResponse` indirectly: the driver carries it along the turn so that any tool the LLM tries to call which is *not* in the list rejects with a clear "tool not available in this turn" error. (Implementation detail: the dispatch strategy stores the per-turn allow-list keyed by `turnId` in a small WeakMap-backed cache, OR — simpler — `handleResponse` re-reads the registry at execute time and lets the registry surface "no such tool" itself. The simpler approach wins; per-turn filtering is the driver's job, not ours.)

## `.d.ts` rendering from JSONSchema7

### Library decision: `json-schema-to-typescript`

Decision: use the [`json-schema-to-typescript`](https://github.com/bcherny/json-schema-to-typescript) library, not a hand-rolled converter.

Rationale:

- JSONSchema7 has a long tail of edge cases (`oneOf`/`anyOf`/`allOf`, `nullable`, `additionalProperties`, `patternProperties`, `$ref`, `enum` vs `const`, `format`). A hand-rolled converter starts simple and grows into a half-broken reimplementation of `json-schema-to-typescript`.
- It is widely used (>3M weekly downloads as of writing), permissively licensed, and Bun-compatible (pure TS, no Node-specific deps).
- It produces deterministic output, which is important for prompt caching: identical tool sets must produce byte-identical `.d.ts` blobs so upstream prompt caching can reuse cache entries across turns.

### Wrapping the library output

The library produces `interface Foo { ... }` for a given schema. We need methods on `kaizen.tools`, which means each tool's parameter schema is rendered to an interface and the method signature references that interface:

```ts
// per tool, emitted into the same .d.ts:
interface ReadFileArgs { path: string }
// ...
declare const kaizen: {
  tools: {
    /** Read a file from disk. */
    readFile(args: ReadFileArgs): Promise<string>;
    "web-search"(args: WebSearchArgs): Promise<unknown>;
  };
};
```

Interface names are derived from the tool name via PascalCase + `Args` suffix. Collisions (two tools named `read-file` and `read_file` both producing `ReadFileArgs`) are resolved by appending a numeric suffix; this is logged at WARN by the dispatch plugin and surfaces in tests.

### Edge case handling

| JSONSchema7 construct | Rendering |
|---|---|
| `type: "string", enum: [...]` | TS string-literal union |
| `type: ["string", "null"]` or `nullable: true` | `string \| null` |
| `additionalProperties: false` | strict object — library default |
| `additionalProperties: true` or schema | `Record<string, T>` index signature added |
| `oneOf` / `anyOf` | TS union (library default) |
| `allOf` | TS intersection (library default) |
| `$ref` | resolved by the library; we do not bundle a remote resolver — refs must be local |
| `format` (e.g. `date-time`, `uri`) | rendered as `string` with JSDoc `@format` tag (no runtime brand types — the LLM does not need them) |
| missing `parameters` | the method is rendered as `<name>(): Promise<unknown>` |
| `parameters` is `{ type: "object" }` with no `properties` | `<name>(args: Record<string, unknown>): Promise<unknown>` |

### Caching

Rendering a `.d.ts` for the same `availableTools` list is pure. The plugin caches the rendered string keyed by a hash of `(tool name, schema JSON)` tuples sorted by name. This matters for:

- Prompt caching at the LLM layer (identical system prompts → cache hit).
- Cost: rendering 50 tools through `json-schema-to-typescript` is not free; one render per turn is one too many when nothing changed.

Cache is in-process, unbounded by tool-set count but bounded by uniqueness of tool sets (in practice: 1–3 entries per session).

## `handleResponse` — extraction, sandboxing, execution

### Signature recap

```ts
handleResponse(input: {
  response: LLMResponse;
  registry: ToolsRegistryService;
  signal: AbortSignal;
  emit: (event: string, payload: unknown) => Promise<void>;
}): Promise<ChatMessage[]>
```

Returns:

- `[]` when the response contains no executable code → terminal turn (assistant just spoke).
- `[<one ChatMessage>]` describing the execution result → driver appends and loops.

### Step 1: code extraction

The extractor walks `response.content` and pulls fenced blocks tagged `typescript`, `ts`, `javascript`, or `js` (case-insensitive). Other languages (` ```python `, ` ```bash `, ` ```text`) are ignored.

**Multiple-block strategy:** concatenate all matching blocks in order, separated by a `\n;\n` separator (defensive against a missing trailing semicolon in block N collapsing into a function call in block N+1). This wins over "first-only" because a model that emits

````
First I'll read config:
```typescript
const cfg = await kaizen.tools.readFile({ path: "config.json" });
```
Then parse it:
```typescript
JSON.parse(cfg);
```
````

is producing valid intent; concatenating reproduces it. It wins over "error on >1" because models *will* emit multi-block intent, and erroring just makes the LLM retry with a worse layout.

**Edge cases:**

- Triple-backticks inside a code block (e.g. the model is showing TS that contains a string literal with backticks). Standard fenced-block parsers handle this; we use a tolerant parser that respects the opening fence's exact length so a `\`\`\`typescript` block can contain a `\`\`\`` substring inside a template literal. We use [`mdast-util-from-markdown`](https://github.com/syntax-tree/mdast-util-from-markdown) or equivalent rather than a naive regex — note this is the one place a regex is *not* good enough.
- No fence info string (` ``` ` with no language). Treated as not-typescript and ignored. The LLM is instructed to always tag.
- Nested fences in markdown blockquotes / lists. The markdown AST handles indentation correctly.

If the AST parser becomes a concern (size, dep weight), the fallback is a hand-rolled state machine over the raw string. This is documented as an acceptable trade — but the AST approach is the recommended default.

### Step 2: emit `codemode:code-emitted`

Emit immediately after extraction so observers (TUI code-block renderer, audit log) see the code before execution begins. Payload: `{ code: <concatenated string>, language: "typescript" }` (we always report `"typescript"` even for `js`-tagged blocks because the sandbox treats them identically — Bun executes both as TS).

### Step 3: emit `codemode:before-execute` (mutable)

Mutable payload `{ code: string }`. Subscribers may rewrite `code` (e.g. a redaction plugin stripping secrets, a policy plugin rejecting dangerous patterns by replacing the code with `throw new Error("blocked by policy")`). After this event resolves, the (possibly-mutated) `code` is what runs.

### Step 4: execute in sandbox

Detailed in the next section.

### Step 5: emit `codemode:result` or `codemode:error`

- Success → `codemode:result` with `{ stdout, returnValue }`.
- Failure → `codemode:error` with `{ message, cause }`.

### Step 6: build a feedback `ChatMessage` and return `[message]`

See "Result surfacing" below.

## Sandbox

### Tech choice: Bun Worker

Decision: spawn a Bun [`Worker`](https://bun.sh/docs/api/workers) for each code block, not `quickjs-emscripten`, not `vm.runInNewContext`.

| Option | Isolation | Speed | Native API access | Verdict |
|---|---|---|---|---|
| **Bun Worker** | Process-level boundary (separate event loop, separate globals); we curate `globalThis` to drop `Bun`, `process`, `require`, `import`, `fs`, `fetch`. Same address space, but no synchronous escape — the worker can only talk back via `postMessage`. | Spawn ~1–5ms; warm pool can amortize. TS executes natively. | Whatever we expose via `postMessage`. | **Recommended.** |
| `quickjs-emscripten` | Strong — separate JS engine, no host capabilities by default. | Spawn ~50ms; execution 10–50× slower than V8. No native TS — must transpile. | Manually marshalled. | Overkill for our threat model; bad UX (slow, transpile burden). |
| `vm.runInNewContext` | Weak — same heap, prototype-pollution escapes documented, `process` reachable through many vectors. | Fast. | Trivial. | Rejected — the LLM is untrusted-ish, and `vm` is famously not a security boundary. |

Threat model: the LLM is *not* an adversary, but it is unreliable. A model in a degenerate state may emit code that loops forever, allocates huge buffers, or imports `child_process`. Bun Worker + curated globals + hard timeout + memory limit is sufficient.

For an actual adversarial threat model (e.g. user shares a session with an attacker who controls model output), `quickjs-emscripten` becomes the right answer; this is documented as a future toggle (`sandbox: "bun-worker" | "quickjs"` config option) but not implemented in v1.

### Worker bring-up

Each `handleResponse` execution does:

1. `new Worker("./sandbox-entry.ts", { type: "module" })` (or, in v1.1, pull from a small idle-pool — see "Pooling" below).
2. Send `{ type: "init", code, allowedTools: string[] }` over `postMessage`.
3. Listen for `{ type: "tool-invoke", id, name, args }` messages and answer them by calling `registry.invoke`.
4. Listen for `{ type: "stdout", chunk }` messages.
5. Listen for one terminal message: `{ type: "done", returnValue } | { type: "error", message, stack }`.
6. Enforce a wall-clock timeout (default 30s, config: `codemode.timeoutMs`); on timeout, `worker.terminate()` and synthesize an error.
7. On `signal.aborted`, same — `worker.terminate()` and report `cancelled`.

The worker entry script:

1. Receives `init`, installs a curated `globalThis.kaizen = { tools: <Proxy> }`, redirects `console.log/info/warn/error` to chunked `postMessage({type:"stdout",chunk})`, then `eval`s the user code wrapped in `(async () => { <code>\n;return undefined; })()`.
2. The Proxy on `kaizen.tools` returns a function for any property access that, when called, posts `{type:"tool-invoke", id, name, args}` and awaits the matching `{type:"tool-result", id, ok, value, error}`.
3. The IIFE's resolved value becomes the `returnValue`. Convention for "last expression": Bun's TS evaluator does not naturally surface the last-expression value of a script. We document the convention: **the LLM must `return` explicitly from inside the wrapper** (the system prompt's example shows a bare expression as the last statement; the wrapper actually does `return (eval-of-wrapped-code)`). Implementation: we wrap the user code as

   ```ts
   (async () => {
     const __kz_capture = (async () => {
       <USER CODE>
     })();
     return await __kz_capture;
   })()
   ```

   and tell the LLM "the last expression OR an explicit `return` is the result". To make a bare last-expression work, the wrapper actually rewrites the last top-level statement: if it's an expression statement, prepend `return `. This is done with a tiny TS AST visit (Bun has `Bun.Transpiler` available in-worker; we use it). This is the **trickiest** part of the design — alternative is to require explicit `return` and document that, accepting that some LLM outputs will return `undefined`.

   **Decision:** require explicit final expression OR `return` at the top level, and use the AST rewrite to auto-wrap a trailing expression statement as a return. The few-shot example demonstrates the bare-expression style.

### Curated globals

The worker entry deletes (or shadows with `undefined`) at minimum:

- `Bun` (the entire Bun namespace)
- `process`, `require`, `module`, `__dirname`, `__filename`
- `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`
- `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask` — wait, no. We **keep** `setTimeout`/`Promise` because user code legitimately needs to await async tool calls. `setInterval` is removed (no use case worth the foot-gun). Wall-clock timeout above bounds runaway loops anyway.
- `import()` (dynamic import) — forbidden; intercepted at transpile time and rewritten to throw.
- `eval`, `Function` — forbidden via `delete globalThis.eval; globalThis.Function = undefined;` (note `Function` is also reachable via `(()=>{}).constructor`; we accept this — the threat model does not require defeating a determined attacker, just an unreliable model).
- All `node:*` and `bun:*` modules — `import` is already gone; if Bun reintroduces top-level `require`, we explicitly remove it.

Allowed:

- `console` (redirected — see below).
- `JSON`, `Math`, `Date`, `Promise`, `Array`, `Object`, the standard built-ins.
- `setTimeout`, `clearTimeout`.
- `globalThis.kaizen` (our injected API).

This is an allow-some/deny-rest list documented in `sandbox-globals.ts`.

### `console` capture

`console.log/info/warn/error/debug` are replaced with a function that:

1. Formats arguments via `Bun.inspect` (or a fallback equivalent).
2. Posts `{type:"stdout", chunk: <formatted + "\n">}`.

The host concatenates chunks into a single `stdout` string. There is no separate `stderr` channel in the result — `console.error` is captured into the same stream prefixed with `[error]` per line. (Rationale: the LLM does not benefit from stream demultiplexing; one feedback string is simpler.)

A `stdout` cap (default 16 KiB, config: `codemode.maxStdoutBytes`) prevents pathological log loops from blowing up the next prompt. On overflow, the captured string is truncated with a `...[truncated, N more bytes]` suffix.

### Tool RPC

The Proxy in the worker turns `kaizen.tools.someTool(args)` into:

```text
worker → host : { type:"tool-invoke", id:"<uuid>", name:"someTool", args }
host  → registry.invoke(name, args, { signal: derivedSignal, callId: id, log: ... })
host  → worker : { type:"tool-result", id, ok:true, value }
                or { type:"tool-result", id, ok:false, error: { message, name } }
```

The worker resolves/rejects the corresponding pending Promise.

`tool-result.error` is sanitized: only `message` and `name` cross the boundary, never the raw `cause` chain (which may contain handles to host objects). The full cause stays on the host and is logged via `tool:error`.

The registry already emits `tool:before-execute`, `tool:execute`, `tool:result`/`tool:error` around `invoke`. This plugin does not re-emit those — it only adds the `codemode:*` envelope around the *whole* code-block run.

### Pooling (v1.1, deferred)

v1: spawn a fresh worker per code block. Cost: ~5ms per spawn. Acceptable.

v1.1: idle-pool of N=2 workers, ready-to-init. Worth it if profiling shows spawn dominating turn latency.

## Result surfacing into the conversation

OpenAI conversation format requires `tool` messages to carry a `toolCallId`. Code mode does not have a `tool_call.id` from the assistant message (the assistant emitted prose + a code fence, not a structured call). Three options were considered:

| Option | Pros | Cons |
|---|---|---|
| (a) Inject a synthetic `tool_call_id`, return a `role:"tool"` message | Stays inside the OpenAI tool-call shape; some inference servers might prefer it. | The matching assistant message has no `tool_calls[]` — most strict OpenAI-compat servers reject `role:"tool"` without a preceding `tool_calls`. Would need to also synthesize the tool_calls onto the assistant message, mutating history. Worse: prompts the LLM to think it's in native tool-call mode, defeating the point. |
| (b) `role:"user"` message with a clearly-marked prefix (`[code execution result]\n...`). | Works on every OpenAI-compat server; LLM sees its own output verbatim; trivially explainable in the system prompt. Matches the "give the LLM feedback like a REPL" mental model. | Conflates user input with system feedback in the message log. Mitigated by the prefix and by the TUI rendering these distinctly. |
| (c) Prepend results to the next assistant turn's content as a system-style preamble. | No extra message in history. | Mutates assistant content the model didn't write; confuses TUIs that render assistant deltas as they stream. |

**Decision: (b).** A `role:"user"` message whose `content` begins with the literal prefix `[code execution result]\n` followed by a structured body. The system prompt (the one this plugin appends) explicitly tells the LLM: "After you emit a code block, you will see a message from the user starting with `[code execution result]`. Treat it as the runtime's response, not a new request from the human."

### Body shape

```
[code execution result]
exit: ok
returned: <JSON-stringified returnValue, truncated to 4 KiB>
stdout:
<captured stdout, truncated to maxStdoutBytes>
```

On error:

```
[code execution result]
exit: error
error: <error.name>: <error.message>
stdout:
<any stdout captured before failure>
```

`returnValue` is JSON-stringified with a custom replacer that handles `undefined` (rendered as `undefined`), `bigint` (rendered as `"<n>n"`), and circular refs (rendered as `"[Circular]"`). Non-JSON-serializable handles (functions, symbols) render as `"[Function]"` / `"[Symbol]"`.

### Why `user` not `system`

OpenAI-compat servers vary in how they interleave `system` messages mid-conversation; some treat only the first `system` as the system prompt and ignore later ones. `user` is universally accepted mid-turn. The prefix is the contract.

## Streaming UX

The driver streams `llm:token` events to the TUI as the LLM produces output. A code-block-aware TUI renderer (in `claude-tui` or its `llm-*` analogue) can:

1. Detect the opening ` ```typescript ` fence in the streamed deltas.
2. Switch the rendering of subsequent deltas to a syntax-highlighted code block region.
3. On the closing fence, lock the block and (optionally) show a "running..." spinner anchored to it.

This plugin does **not** participate in streaming. `handleResponse` is called once with the *complete* `LLMResponse`. The TUI's streaming view is independent.

Buffering rule: code is **not** executed until the whole response is in. Partial code fences during streaming are display-only. This matches user expectation (you don't run half a function) and avoids the complexity of speculative execution.

## Error handling

Every failure path emits `codemode:error` with a normalized `{ message, cause? }` and produces a `[code execution result]` user message with `exit: error`, so the LLM can self-correct on the next turn.

| Failure | Detection | Message to LLM |
|---|---|---|
| Syntax error in user code | Bun's TS transpile throws inside the worker entry before user code runs | `error: SyntaxError: <details>` — the line/column refer to the wrapped code, which is fine because the wrapper preamble is fixed and the LLM can count |
| Runtime exception | Worker entry catches and posts `{type:"error", message, stack}` | `error: <name>: <message>` — first 5 stack frames included |
| Timeout | Host wall-clock alarm fires before `done` arrives | `error: TimeoutError: code did not complete within 30000ms` |
| Memory / worker crash | `worker.onerror` or `worker.exitCode !== 0` without prior `done` | `error: WorkerCrash: <details if any>` |
| Cancellation (signal) | `signal.aborted` while waiting | We do **not** push a feedback message in this case — turn is being torn down; we throw `AbortError` from `handleResponse` and let the driver's turn-cancel path handle it |
| Unknown tool called | `kaizen.tools.<name>(...)` for an unregistered name → registry throws | Error propagates back into worker as a rejected Promise; if uncaught by user code, becomes a runtime exception (above). The registry-level error message ("no tool registered with name 'X'") is preserved verbatim so the LLM can see the typo. |
| Tool call args invalid | Registry validates against the tool schema and rejects | Same path — runtime exception with the validation message |
| stdout overflow | Host counts bytes as chunks arrive | Not an error; result is delivered with `[truncated]` marker |

### What does the LLM see for "tool not in availableTools this turn"?

The list passed to `prepareRequest` is the same one rendered into the `.d.ts`. So the LLM should not *type-check* a call to a missing tool — but the LLM may ignore the types. If it calls a name absent from the registry, it gets the registry's "unknown tool" error. If it calls a name that exists in the registry but was filtered out for *this* turn — the registry today does not enforce per-turn filters; that is an open question for Spec 2 (`llm-driver`). For v1, this plugin documents the gap and relies on the driver to enforce filters by passing only the allowed slice into `availableTools` and trusting the registry to be the single source of truth at execute time. (If a tool was registered after `prepareRequest` ran and the LLM somehow knows about it, calling it succeeds — this is benign.)

## Cancellation

`signal: AbortSignal` from `handleResponse`'s input drives two cleanup actions, in parallel:

1. The host's wait-for-worker-done promise is racing with `signal.aborted`. On abort, `worker.terminate()` is called (synchronous, immediate).
2. A child `AbortController` per in-flight `registry.invoke` is aborted. The registry contract gives each `ToolHandler` a `signal` via `ToolExecutionContext`; aborting it propagates to the underlying tool implementation (HTTP request, file read, etc.).

`handleResponse` rethrows `AbortError` rather than returning. The driver catches it during `turn:cancel` handling.

There is no half-state: terminating the worker drops any pending `tool-invoke` messages on the floor, which means in-flight tool calls may have already started host-side. The host-side `registry.invoke` calls each have their own signal and will abort independently. We accept that a tool may have produced side effects before the abort lands — the registry's contract already covers this.

## Configuration

Plugin reads (with defaults):

| Key | Default | Meaning |
|---|---|---|
| `codemode.timeoutMs` | `30000` | Wall-clock cap on a single code-block execution |
| `codemode.maxStdoutBytes` | `16384` | Truncate stdout above this size |
| `codemode.maxReturnBytes` | `4096` | Truncate JSON-stringified return value |
| `codemode.maxBlocksPerResponse` | `8` | Hard cap on number of fenced blocks concatenated; excess emits a warning to the LLM |
| `codemode.sandbox` | `"bun-worker"` | Reserved for future `"quickjs"` toggle |

Loaded via the same kaizen config mechanism every other plugin uses (TBD per Spec 0; placeholder reference here).

## Permissions

`unscoped`. Justification:

- The *plugin itself* is trusted: it ships from this repo and runs as part of the harness.
- The *code it executes* is constrained by what we expose in the sandbox — the `kaizen.tools` API is the entire capability surface, and each tool in the registry has its own permission scope enforced by its registering plugin.
- We mark the plugin `unscoped` rather than `trusted` to make explicit that the user is opting into "this plugin runs LLM-authored JavaScript locally". A user who does not trust the LLM must use `llm-native-dispatch` instead.

The harness manifest's plugin entry for `llm-codemode-dispatch` will carry a one-line warning that the user sees on first install, mirroring how `claude-wrapper` flags plugins that touch the network.

## Public API surface (`public.d.ts`)

This plugin exports very little. Everything inter-plugin lives on the service.

```ts
// public.d.ts
import type { ToolDispatchStrategy } from "@kaizen/llm-events";

export interface CodeModeConfig {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxReturnBytes?: number;
  maxBlocksPerResponse?: number;
  sandbox?: "bun-worker";
}

// Plugin's default export (or service value) satisfies ToolDispatchStrategy.
// No additional types are exported — the .d.ts the LLM sees is generated at
// runtime, not part of this package's public types.
```

The shape of the synthetic feedback message and the `[code execution result]` prefix is **documented** here but not exported as a constant — other plugins should not pattern-match against it. (If they need to, expose a parser later.)

## Test plan

### Unit

- **DTS rendering**:
  - simple `{ type: "string" }` parameter → `string`
  - `enum` → string-literal union
  - `nullable` and `type: ["string","null"]` both → `string | null`
  - `oneOf` → union, `allOf` → intersection
  - non-identifier tool name → bracket-quoted method
  - empty/missing parameters → `(): Promise<unknown>` and `(args: Record<string, unknown>): Promise<unknown>` respectively
  - deterministic output: same input twice → byte-identical string
  - cache hit on identical input

- **Code extraction**:
  - one ` ```typescript ` block → extracted
  - one ` ```ts ` block → extracted, treated as typescript
  - one ` ```javascript ` block → extracted
  - mixed: ` ```python `, ` ```typescript `, ` ```text ` → only typescript taken
  - two typescript blocks → concatenated with `\n;\n`
  - no fenced blocks → returns `[]`
  - block with no language tag → ignored
  - block with backticks inside a template literal → preserved correctly (markdown AST, not regex)
  - response with leading/trailing whitespace, CRLF line endings → handled

- **Result-message shaping**:
  - success returns the `[code execution result]\nexit: ok\n...` shape exactly
  - error returns the `exit: error` shape
  - `undefined` return → rendered as `undefined`
  - `bigint` return → rendered as `"<n>n"`
  - circular reference → `"[Circular]"`
  - oversized return → truncated with marker
  - oversized stdout → truncated with marker

### Integration (mocked registry)

- `prepareRequest` returns a `systemPromptAppend` containing every tool name and description, in deterministic order (alphabetical by name).
- `handleResponse` with no code blocks → resolves to `[]`, no events emitted besides nothing.
- `handleResponse` with one block calling `kaizen.tools.X({...})` where the mock registry resolves to `42`:
  - emits `codemode:code-emitted`, `codemode:before-execute`, `codemode:result` in order
  - returned message body contains `returned: 42`
- `codemode:before-execute` subscriber that mutates `code` to `throw new Error("blocked")` → `codemode:error` emitted, error message contains "blocked".
- Mock registry that throws `Error("no such tool: foo")` for `kaizen.tools.foo()` → error surfaces back to the LLM via the feedback message verbatim.

### End-to-end (real Bun Worker)

- A registered tool that returns `{ ok: true }`. LLM-style response containing
  ```typescript
  await kaizen.tools.echo({ greeting: "hi" });
  ```
  → returnValue is `{ ok: true }`, stdout is empty.
- A code block that does `console.log("a"); console.log("b"); return 1;` → stdout `"a\nb\n"`, returnValue `1`.
- A code block that throws → `codemode:error` emitted with the thrown message, feedback message has `exit: error`.
- A code block that runs an infinite loop → terminates within `timeoutMs + small slack`, error is `TimeoutError`.
- A code block that calls `eval("1+1")` → throws (eval removed).
- A code block that does `import("node:fs")` → throws (dynamic import disallowed).
- A code block that calls `setInterval(...)` → throws (`setInterval is undefined`).

### Cancellation

- Mid-execution `AbortController.abort()` → `handleResponse` rejects with `AbortError`, worker is terminated, in-flight `registry.invoke` signals are aborted.
- Cancellation while *queued* (before worker spawned) → never spawns the worker.

### Determinism / caching

- Two `prepareRequest` calls with the same `availableTools` produce byte-identical strings; the second hits the renderer cache (verified via a counter on the renderer mock).

### Failure-mode goldens

A small "the model emits garbage" suite to lock in error message text, since that text is what the LLM will see and learn from:

- Truly empty response → `[]`.
- Response with prose but no code → `[]`.
- Response with `python` code → `[]`.
- Response with malformed (unterminated) fence → `[]` (we do not "best effort" close fences; it's safer to no-op and let the LLM resend).
- Response with 9 code blocks at the default cap of 8 → first 8 concatenated; warning string appended to the feedback message: `note: 1 additional code block(s) were ignored because the limit is 8`.

## Open questions deferred

- **Per-turn tool allow-list enforcement.** Whether `tools:registry.invoke` consults a per-turn filter, or whether the dispatch strategy stores its own allow-list keyed by `turnId`, is decided in Spec 4 (`llm-tools-registry`). This spec assumes the registry is the source of truth; if Spec 4 chooses otherwise, `handleResponse` here gains a small allow-set check before forwarding `tool-invoke` to the registry.
- **Streaming TUI integration.** The TUI plugin that renders code blocks during streaming is its own spec (likely a small extension to `claude-tui` or a sibling `llm-tui` plugin). This spec only guarantees that `handleResponse` runs against a complete response.
- **Pooling.** Worker pre-spawn pool is deferred to v1.1.
- **`quickjs-emscripten` toggle.** Reserved as `codemode.sandbox = "quickjs"` config; not implemented in v1.
- **AST-based last-expression rewrite.** The wrapper that auto-converts a trailing expression statement into a `return` is the design's most fragile piece. If implementation surfaces it as too brittle, the fallback is to require explicit `return` and update the system prompt + few-shot accordingly. Both paths are acceptable.

## Acceptance criteria

- Plugin builds, passes all unit + integration tests, and runs in the C-tier harness as the default dispatch strategy.
- A real local LLM (Llama 3.1 8B Instruct or equivalent) given a 3-tool registry can complete a `read file → grep → write file` task end-to-end in code mode without manual prompting beyond the system prompt this plugin generates.
- Cancellation during a long-running code block (a tool that sleeps 60s) returns control to the user within 200ms of `Ctrl+C`.
- Disabling `llm-codemode-dispatch` and enabling `llm-native-dispatch` requires zero changes elsewhere — the driver and registry behave identically.
- The `.d.ts` generated for the local-tools tool set fits within 4 KiB for ≤20 tools (a soft target — if exceeded we revisit description trimming).

## Changelog

- 2026-04-30: initial draft.
