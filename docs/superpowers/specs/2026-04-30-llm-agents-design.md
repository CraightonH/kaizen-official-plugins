# `llm-agents` — Design (Spec 10)

**Status:** draft
**Date:** 2026-04-30
**Scope:** The `llm-agents` plugin: agent discovery from on-disk markdown manifests, the `agents:registry` service, the `dispatch_agent` tool, and recursive invocation of `driver:run-conversation` to run a sub-conversation per dispatch.
**Depends on:** Spec 0 (foundation contracts). Contracts defined there are authoritative; this spec only describes implementation choices internal to the plugin.

## Goal

Let the parent LLM delegate sub-tasks to specialized "agents" — narrow personas with their own system prompts, restricted tool sets, and (optionally) model overrides — by emitting a single `dispatch_agent` tool call. Each dispatch runs a fresh, recursive `runConversation` whose final assistant message is returned as the tool result. The mechanism is structurally identical to Claude Code's Task subagents but framed for the openai-compatible harness.

## Non-goals

- Streaming of sub-agent token output to the TUI (deferred; v0 runs agents silently).
- Persistent agent state across dispatches (each dispatch is a fresh conversation).
- A UI for editing agent files (users author markdown directly).
- Capability negotiation beyond the tool/tag filter declared in the manifest.
- Dynamic per-call tool grants (manifest is the contract; LLM cannot widen it).

## Architectural overview

The plugin owns three concerns:

1. **Discovery.** Scan two well-known directories (`~/.kaizen-llm/agents/` and `<project>/.kaizen-llm/agents/`) for `*.md` agent files at startup. Parse each into an `AgentManifest`. Project-scoped agents shadow user-scoped agents on name collision.
2. **Registry.** Provide the `agents:registry` service defined in Spec 0. Loaded manifests are exposed via `list()`; programmatic registration via `register()` is supported (e.g., a future plugin could register synthetic agents).
3. **Dispatch.** Register one tool — `dispatch_agent` — into `tools:registry`. When invoked, look up the named manifest, build a `RunConversationInput`, recurse into `driver:run-conversation`, and return the final assistant message content as the tool result. Subscribe to `turn:start` to inject an "Available agents" section into the parent's outgoing system prompt so the LLM knows what it can dispatch.

The plugin owns no conversation state of its own. Each dispatch is a leaf in the turn tree the driver maintains; recursion depth is bounded by walking the `parentTurnId` chain.

## Agent file format

Agent files are markdown with YAML frontmatter. They live in:

- `~/.kaizen-llm/agents/*.md` (user scope, available across projects)
- `<project-root>/.kaizen-llm/agents/*.md` (project scope, shadows user scope)

`<project-root>` is the directory containing the harness file the user launched, located by walking up from `process.cwd()` until a `harnesses/` sibling or `.kaizen-llm/` directory is found. If neither is found, project scope is skipped and only user-scope agents load.

### Frontmatter schema

```yaml
---
name: code-reviewer            # required, unique within scope; [a-z0-9_-]+
description: >-                # required; shown to parent LLM verbatim
  Use when the user wants a focused review of a diff or specific file.
  The agent reads code and returns inline review comments grouped by file.
tools: ["read_file", "list_files", "grep*"]   # optional; allow-list with `*` wildcards
tags: ["read-only"]                            # optional; alternative tool filter
model: "gpt-4o-mini"                           # optional; provider model id override
---
```

### Body

Everything after the closing `---` is the agent's system prompt, used verbatim as `RunConversationInput.systemPrompt`. Markdown is preserved as-is — the LLM consumes it as plain text. There is no template engine in v0.

### Resolution rules

- `name` is the dispatch identifier and must be unique. On collision within a scope, the lexicographically first file wins and a `session:error` is emitted at load time naming the duplicates.
- `tools` and `tags` are independent allow-lists; if both are set, a tool is admitted if it matches **either**. If both are absent, the agent gets only the always-on tools (see "Tool filtering" below).
- `model` is opaque — passed through to `RunConversationInput.model`. The driver/provider plugin validates it.
- Frontmatter parse errors mark the file as failed; it is skipped and a `session:error` event is emitted with the file path and parser message. The rest of the registry continues loading.

## Discovery and lifecycle

- **Load timing:** Discovery runs once during plugin activation, after `tools:registry` and `driver:run-conversation` services are resolved. Activation does not block on file I/O — discovery runs in a microtask, and `dispatch_agent` returns a "registry not ready" tool error if invoked before completion.
- **No watch in v0:** Files are read once. To pick up edits, the user restarts the harness. (Future: optional fs.watch behind a setting; out of scope here.)
- **Symlinks:** Followed once to avoid loops; cycles are detected and reported as `session:error`.
- **File size cap:** 64 KiB per agent file. Files over the cap are skipped with an error.

## Service interface

The plugin satisfies `agents:registry` exactly as defined in Spec 0:

```ts
export interface AgentsRegistryService {
  list(): AgentManifest[];
  register(manifest: AgentManifest): () => void;   // returns unregister
}
```

Internal manifest shape extends Spec 0's `AgentManifest` only with fields the plugin needs at dispatch time; these are NOT part of the public contract:

```ts
interface InternalAgentManifest extends AgentManifest {
  modelOverride?: string;
  sourcePath: string;          // for diagnostics
  scope: "user" | "project";
}
```

`list()` returns the public `AgentManifest` view (no internal fields). The dispatch tool reads the internal record from a private map keyed by `name`.

## The `dispatch_agent` tool

Registered into `tools:registry` at activation, with this schema:

```jsonc
{
  "name": "dispatch_agent",
  "description": "Delegate a sub-task to a named specialist agent. Returns the agent's final response as a string. Use when a sub-task benefits from a focused persona or restricted tool set.",
  "parameters": {
    "type": "object",
    "required": ["agent_name", "prompt"],
    "properties": {
      "agent_name": { "type": "string", "description": "One of the names listed under 'Available agents' in the system prompt." },
      "prompt":     { "type": "string", "description": "The instruction to send to the agent as its only user message." }
    },
    "additionalProperties": false
  },
  "tags": ["agents", "core"]
}
```

### Handler flow

On `invoke("dispatch_agent", { agent_name, prompt }, ctx)`:

1. **Lookup.** Resolve `agent_name` against the internal manifest map. Missing → throw a tool error with message `"Unknown agent '<name>'. Known: <list>"`. The driver surfaces this as `tool:error`; the parent LLM sees it as a normal tool failure and may retry.
2. **Depth check.** Compute the current depth by walking the `parentTurnId` chain stored in the driver's turn registry (see Spec 0 `turn:start` payload). If depth ≥ `agents.maxDepth` (default 3), throw a tool error `"Agent dispatch depth limit reached (max=N)"`. The depth limit is read from the harness settings file under the `agents` namespace.
3. **Build input.** Construct `RunConversationInput`:
   - `systemPrompt` = manifest body.
   - `messages` = `[{ role: "user", content: prompt }]`.
   - `toolFilter` = manifest's `toolFilter` merged with the always-on tool names (see below). The driver applies this when listing tools for the sub-conversation.
   - `model` = `manifest.modelOverride` if set; else omit (driver uses default).
   - `parentTurnId` = the current turn id from `ctx` (added to `ToolExecutionContext` — see "Spec 0 dependency" below).
   - `signal` = `ctx.signal` (the parent's cancellation token).
4. **Invoke.** `await driver.runConversation(input)`.
5. **Return.** Stringify `output.finalMessage.content` and return it as the tool result. The driver wraps it in a `tool` ChatMessage and the parent LLM continues.

### Tool filtering for the sub-conversation

The sub-conversation sees:

- Tools matching the manifest's `tools`/`tags` allow-list, AND
- The always-on `dispatch_agent` tool itself (so agents can recurse up to `maxDepth`), AND
- `load_skill` if the `skills:registry` service is available (so agents can pull in skills).

Wildcard matching for `tools` is glob-style (`*` matches any run, no other metacharacters). Filtering happens by passing `RunConversationInput.toolFilter` to the driver; the driver narrows the registry view it presents to the dispatch strategy. The agents plugin does NOT mutate the global registry.

If the resulting filter is empty (manifest excludes everything and no skills plugin is present), the agent still runs but with only `dispatch_agent` available — useful for "router" agents.

## System-prompt injection

The plugin subscribes to `turn:start` for top-level turns only (`trigger === "user"`). It does NOT inject for nested agent turns — the sub-agent's system prompt is the manifest body, and listing peer agents inside an agent's prompt invites confused recursion.

Injection happens via `llm:before-call` (mutable). On each first-LLM-call of a top-level turn, the plugin appends a section to `request.systemPrompt`:

```
## Available agents (use dispatch_agent to invoke)

- code-reviewer: Use when the user wants a focused review of a diff or specific file.
- doc-writer: Use to draft or revise prose documentation. Prefer this over inline edits for >50-line docs.
```

One bullet per agent: `name: description` (description trimmed to a single line, soft-wrapped at ~200 chars). If the registry is empty, the section is omitted entirely.

To avoid double-injection across multi-call turns, the plugin tracks injected `turnId`s in a Set cleared on `turn:end`.

## Recursion semantics

- **Depth tracking.** Each `runConversation` invocation receives a `parentTurnId` and the driver emits `turn:start` with both `turnId` and `parentTurnId`. The agents plugin walks the chain on dispatch to compute depth — N hops from the current turn back to a turn whose `trigger === "user"`.
- **Default cap.** `agents.maxDepth = 3` (user → agent → sub-agent → leaf-agent). Configurable via harness settings.
- **Why a cap.** Cheap insurance against runaway loops where two agents dispatch each other. The cap is a tool-error, not a silent truncation, so the parent LLM can react.
- **No fan-out cap.** A single agent may issue many sequential `dispatch_agent` calls. Cost is bounded by the model's context window and the user's wallet, not by this plugin.

## Cancellation

- The driver passes `ctx.signal` (the parent turn's `AbortSignal`) into every tool handler. The dispatch handler forwards it to the recursive `runConversation` as `input.signal`. The driver internally chains turn-level signals so a cancel on the root turn aborts every descendant conversation in flight.
- `turn:cancel` events targeted at any ancestor turn id propagate via `AbortSignal` chaining. The agents plugin does not need to subscribe.
- On cancellation, the recursive `runConversation` rejects with an `AbortError`. The dispatch handler converts this into a tool error with message `"Agent '<name>' cancelled"`, surfaced as `tool:error`. The parent's own conversation also resolves with `turn:end { reason: "cancelled" }` so the cleanup is idempotent.

## Streaming and observability

- **Streaming to TUI: NO in v0.** The sub-agent's `llm:token` events still fire on the bus (the driver emits them), but the `claude-tui`-equivalent consumer for `llm-events` is expected to filter on top-level turn id. Sub-agent tokens are not displayed.
- **Status item.** The plugin sets `status:item-update { key: "agents.active", value: "<agent-name>" }` on dispatch start and clears it on completion. Multiple concurrent dispatches use a counter `value: "<n> active"`.
- **Future:** A tree-view in the TUI showing per-agent activity will subscribe to `turn:start`/`turn:end` filtered by `parentTurnId !== undefined`. That work is out of scope; the events already exist on the bus.

## Token budget

Agents inherit the parent's model context window — they share no token pool with the parent at the LLM level (each `runConversation` is a separate API call sequence). Documented behavior:

- Each dispatch starts a fresh conversation; the agent does not see the parent's history.
- The agent manages its own context within its own turn loop. If it exhausts its window, the driver/provider returns `finishReason: "length"` and the dispatch tool returns whatever partial content the agent produced.
- The parent pays for the system prompt + initial user message + all sub-agent LLM calls, accumulated in `RunConversationOutput.usage`. The dispatch handler does NOT add this to the parent's running usage automatically; the driver's usage accounting is responsible (out of scope for this spec).

Users authoring agents should keep system prompts tight — they are the recurring overhead on every dispatch.

## Error surfacing

All failure modes return as **tool errors** in the parent's conversation, never as plugin crashes:

| Failure | Tool-error message |
|---|---|
| Unknown agent name | `Unknown agent '<name>'. Known: <comma list>` |
| Depth exceeded | `Agent dispatch depth limit reached (max=N)` |
| Cancelled | `Agent '<name>' cancelled` |
| Sub-conversation threw | `Agent '<name>' failed: <inner message>` |
| Registry not ready | `Agent registry still loading; retry` |

Each emits `tool:error` via the registry's normal path so observers (logging, status) see them uniformly. The parent LLM may retry, swap agents, or report to the user — the plugin does not retry automatically.

## Spec 0 dependency: `parentTurnId` access from a tool handler

The dispatch handler needs the *current* turn id to build the recursive `parentTurnId`. Spec 0's `ToolExecutionContext` currently exposes only `signal`, `callId`, and `log`. To avoid a brittle global lookup, this spec proposes adding:

```ts
export interface ToolExecutionContext {
  signal: AbortSignal;
  callId: string;
  log: (msg: string) => void;
  turnId: string;          // NEW — the turn that originated this tool call
}
```

This is a **cross-plugin contract change** and per Spec 0's propagation rule must be made in Spec 0 first. Action item for the implementer of this spec: open the Spec 0 edit before merging Spec 10. If the foundation team rejects the addition, the fallback is for the agents plugin to subscribe to `turn:start` and maintain its own `callId → turnId` map, which is messier but works.

## Settings

Read from the harness settings file under the `agents` namespace:

```jsonc
{
  "agents": {
    "maxDepth": 3,                  // integer, ≥1
    "userDir": "~/.kaizen-llm/agents",
    "projectDir": ".kaizen-llm/agents"
  }
}
```

All keys optional; defaults shown. Unknown keys are ignored.

## Permissions

`unscoped`. The plugin recursively invokes the driver, which orchestrates everything — there is no smaller permission envelope that captures "may dispatch arbitrary tool sets through a sub-conversation." Reviewers should treat this plugin as trusted infrastructure, equivalent to `llm-driver` itself.

## Test plan

Unit and integration tests, all using the in-memory plugin host that exercises the bus + service registry without spawning a real LLM.

1. **Frontmatter parsing**
   - Valid file → manifest loads with all fields.
   - Missing required field (`name` or `description`) → file rejected, `session:error` emitted, other agents continue loading.
   - Malformed YAML → file rejected with parser message in the error.
   - Body-only file (no frontmatter) → rejected.
   - File over 64 KiB → rejected.

2. **Discovery**
   - User-scope only loads when no project scope present.
   - Project-scope agent shadows user-scope agent of the same name; warning emitted.
   - Symlink cycle detected and reported.

3. **Registry service**
   - `list()` returns loaded manifests, hides internal fields.
   - `register()` adds a synthetic agent and returns a working unregister.

4. **Dispatch via tool call**
   - Driver invokes `dispatch_agent` → recursive `runConversation` called with the manifest's system prompt and the parent's signal.
   - Final `assistant` message content returned as tool result string.
   - `model` override propagates to `RunConversationInput.model`.

5. **Tool filtering**
   - Sub-conversation receives only tools matching `tools`/`tags` plus `dispatch_agent` plus `load_skill` (when skills plugin loaded).
   - Wildcard `tools: ["read_*"]` matches `read_file`, `read_url`; rejects `write_file`.
   - Empty filter still grants `dispatch_agent`.

6. **Recursion limit**
   - Depth N (default 3) succeeds; depth N+1 returns the depth tool error.
   - `maxDepth: 1` setting blocks any dispatch from inside an agent.

7. **Cancellation cascade**
   - Aborting parent signal mid-dispatch causes the recursive `runConversation` to reject; tool error returned with cancelled message.
   - `turn:cancel` on the root turn aborts a depth-3 dispatch within ~50ms (timing test, generous bound).

8. **Error surfacing**
   - Unknown agent name → tool error, parent turn continues.
   - Sub-conversation throws → tool error wraps inner message; no plugin crash.
   - Registry-not-ready → distinct error code; second call after load completes succeeds.

9. **System-prompt injection**
   - Top-level `turn:start` triggers append; nested turn does not.
   - Multi-LLM-call top-level turn injects only on the first call.
   - Empty registry omits the section entirely.

10. **End-to-end** (integration)
    - With a stub `llm:complete` that emits a single `dispatch_agent` tool call followed by a stop, the parent turn completes with the agent's response inlined as a tool message and the assistant's follow-up.

## Acceptance criteria

- Plugin builds, tests pass, marketplace catalog updated.
- A C-tier harness using `llm-agents` can dispatch a depth-1 agent end-to-end against a stub provider.
- Spec 0 update for `ToolExecutionContext.turnId` is merged (or the fallback design is documented in the implementation plan).
- Documentation includes a sample agent file in `examples/agents/code-reviewer.md`.

## Open questions

- Should agent dispatches show up in the TUI by default behind a verbose flag, or stay fully silent until the tree-view lands? (Defaulting to silent; revisit when the tree-view spec is written.)
- Should `register()` allow overriding a file-loaded agent of the same name, or refuse? (v0: refuse; programmatic registration uses a separate namespace prefix `runtime:` to avoid collisions.)
- Concurrent dispatch from one parent turn — supported by the driver, but worth a stress test once provider streaming is real. Tracked as a follow-up.
