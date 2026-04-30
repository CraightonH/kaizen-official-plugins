# MCP Bridge — `llm-mcp-bridge` (Spec 11)

**Status:** draft
**Date:** 2026-04-30
**Spec:** 11 of the openai-compatible harness ecosystem
**Depends on:** Spec 0 (`2026-04-30-openai-compatible-foundation-design.md`), Spec 4 (`llm-tools-registry`), Spec 7 (`llm-skills`)
**Tier:** 3 (C-tier harness)

## Goal

Connect kaizen's openai-compatible harness to one or more Model Context Protocol (MCP) servers and re-publish their capabilities into kaizen's plugin registries (`tools:registry`, `skills:registry`) so that, from the LLM's point of view, MCP-provided tools and prompts are indistinguishable from natively-registered ones.

This makes the harness immediately useful: any of the dozens of existing MCP servers (filesystem, github, slack, postgres, etc.) become available with no kaizen-specific glue, just a config file entry.

## Non-goals

- Implementing any MCP server. This plugin is purely a *client* of MCP servers.
- Building a UI for managing MCP servers (configuration is file-based).
- Sandboxing MCP server processes — they run with the same privileges as the harness. This is documented; not enforced.
- Translating MCP resources into a full `memory:store` implementation (Spec 9 owns memory). Resources are exposed via a single `read_mcp_resource` tool in v0.
- Bidirectional bridging (exposing kaizen tools *to* MCP clients). One-way: MCP → kaizen.
- Hot-replacing the MCP SDK or supporting non-standard transports.

## Architectural overview

`llm-mcp-bridge` participates in the harness as a capability plugin (Tier 3). On `setup`:

1. Read MCP config file(s).
2. For each enabled server, instantiate an MCP client of the appropriate transport (stdio, SSE, HTTP).
3. Connect, perform the MCP `initialize` handshake, list capabilities.
4. For each MCP tool, register a kaizen tool into `tools:registry` whose handler proxies invocations back over the MCP transport.
5. For each MCP prompt, register a skill into `skills:registry` whose loader fetches the rendered prompt body via MCP `prompts/get`.
6. Register a single `read_mcp_resource({ server, uri })` tool to expose resources.
7. Provide an `mcp:bridge` service for introspection and runtime reload.
8. Subscribe to `session:end` for clean shutdown.

The plugin owns no event vocabulary additions. All cross-plugin communication is via existing services and events from Spec 0. Tool errors surface through the standard `tool:error` event because MCP-backed handlers go through `tools:registry.invoke` like any other tool.

The bridge is **passive after setup**: once tools are registered, the driver, dispatch strategy, and TUI never touch this plugin again — they just see entries in the registry. The bridge only re-engages for health checks, reconnects, and explicit `/mcp reload`.

## Configuration

### File locations (resolved in order; first existing file wins, multiple files are merged with later overriding earlier)

1. `<project>/.kaizen-llm/mcp.json` (project-scoped)
2. `~/.kaizen-llm/mcp-servers.json` (user-scoped)
3. Path supplied via env var `KAIZEN_MCP_CONFIG` (CI / one-off override)

If no file exists, the plugin logs an info message and registers zero MCP tools. Absence of config is not an error.

### Schema

The format intentionally mirrors Claude Code's MCP configuration so users can copy entries between the two:

```jsonc
{
  "servers": {
    "filesystem": {
      "transport": "stdio",                                 // optional; inferred from fields
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/code"],
      "env": { "DEBUG": "1" },                              // optional
      "cwd": "/Users/me",                                   // optional
      "enabled": true,                                      // default true
      "timeoutMs": 30000                                    // request timeout, default 30s
    },
    "github": {
      "transport": "sse",
      "url": "https://mcp.example.com/sse",
      "headers": { "Authorization": "Bearer ${env:GITHUB_MCP_TOKEN}" }
    },
    "internal-api": {
      "transport": "http",
      "url": "http://localhost:8080/mcp",
      "headers": { "X-API-Key": "${env:INTERNAL_KEY}" }
    }
  }
}
```

**Inference:** if `transport` is omitted, it is inferred — `command` ⇒ `stdio`, `url` with no other hint ⇒ `http`, explicit `"sse"` required when SSE is wanted.

**Env interpolation:** `${env:VAR}` in any string value is resolved at load time. Missing vars produce a config error for that server (the server is skipped, others continue).

**Reserved names:** server names must match `/^[a-z0-9][a-z0-9_-]*$/` because they participate in tool names. Invalid names are skipped with a warning.

## MCP SDK and transport handling

**Dependency:** `@modelcontextprotocol/sdk` (the official TypeScript SDK). Pin to a specific minor version in `package.json`. Document the version in the plugin README.

### Transport-specific lifecycle

| Transport | Connect | Health check | Reconnect | Shutdown |
|---|---|---|---|---|
| `stdio` | Spawn subprocess; pipe stdin/stdout to the SDK's `StdioClientTransport`. | Process liveness (`pid` exists) + periodic `ping` request. | On exit code != 0 or unexpected close: respawn with exponential backoff (1s, 2s, 4s, 8s, capped at 60s, max 5 retries before quarantine). | SIGTERM, then SIGKILL after 5s if still alive. |
| `sse` | Open EventSource to `url`. | Stream-alive + periodic `ping`. | On stream close: re-open with same backoff curve. | Close EventSource. |
| `http` | No persistent connection. Each `tools/call`, `prompts/get`, `resources/read` is a fresh request. | Periodic `ping` request to confirm reachability. | N/A — every request is independent. Failures count toward a circuit breaker; after N consecutive failures the server is marked `unreachable`. | No-op. |

Health-check interval default: 60s. Configurable per-server via `healthCheckMs`.

A server in `quarantined` state does not respawn automatically. Tools belonging to it remain registered but their handlers return a structured error (`mcp_server_unavailable`). The server can be revived via `/mcp reload` or `mcp:bridge.reconnect(serverName)`.

## Translation: MCP capabilities → kaizen registries

### Tools (MCP `tools/list` → `tools:registry`)

For each MCP tool reported by server `<server>`:

- **kaizen tool name:** `mcp:<server>:<toolname>`
- **description:** the MCP tool's description (verbatim).
- **parameters:** the MCP tool's JSON schema (verbatim — MCP's `inputSchema` is already JSONSchema7-compatible).
- **tags:** `["mcp", "mcp:<server>"]`. Capability plugins (agent toolFilter, dispatch strategies) can include/exclude by tag.
- **handler:** invokes `client.callTool({ name, arguments })` over the MCP transport, awaiting up to `timeoutMs`. Result content blocks are flattened to a string when the LLM expects text; structured content is returned as JSON.

Namespacing eliminates collisions between servers (two servers each exposing `search` are registered as `mcp:github:search` and `mcp:filesystem:search`).

**Error mapping:**
- MCP protocol error → throw an `Error` with message `mcp:<server>:<tool> failed: <message>`. The registry's `invoke` catches it and emits `tool:error`. The dispatch strategy turns that into a tool-result message visible to the LLM.
- Timeout → same path, message `mcp:<server>:<tool> timed out after <ms>ms`.
- Server quarantined → fast-fail with `mcp_server_unavailable`; do not attempt the call.

### Prompts (MCP `prompts/list` → `skills:registry`)

MCP "prompts" are textual templates the server suggests; kaizen "skills" are textual blobs the LLM can pull into context. The mapping is direct:

- **skill name:** `mcp:<server>:<promptname>`
- **description:** the MCP prompt's description.
- **tokens:** estimated lazily (cached after first load).
- **loader:** calls `client.getPrompt({ name, arguments: {} })` and concatenates the returned message contents into a single body. Prompts that require arguments are skipped in v0 with a warning (skills have no argument-passing path) — revisit in a follow-up if needed.

The skill becomes loadable through the standard `load_skill` tool, identical to file-backed skills.

### Resources (MCP `resources/list`)

Resources are not enumerated into the registry — there can be thousands. Instead a single tool is registered:

- **name:** `read_mcp_resource`
- **description:** `Read an MCP resource by URI. Use mcp:bridge.list_resources or list_mcp_resources to discover URIs.`
- **parameters:** `{ server: string, uri: string }`
- **handler:** routes to the named server's `client.readResource({ uri })`, returns the content.

Plus a discovery tool:

- **name:** `list_mcp_resources`
- **parameters:** `{ server?: string }`
- **handler:** aggregates `client.listResources()` across all healthy servers (or one if `server` given).

This keeps the LLM's tool budget small while still letting it browse.

### Roots, sampling, completion

MCP also defines roots, sampling, and completion. v0 ignores them; revisit if user demand surfaces. Document this gap in the README.

## Service interface — `mcp:bridge`

The plugin's only service. Used by the `/mcp` slash command, the status bar, and any debugging hook.

```ts
export type ServerStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "quarantined"
  | "disabled";

export interface ServerInfo {
  name: string;
  transport: "stdio" | "sse" | "http";
  status: ServerStatus;
  toolCount: number;
  promptCount: number;
  resourceCount: number;     // -1 if not yet listed
  lastError?: string;
  connectedAt?: number;
  reconnectAttempts: number;
}

export interface McpBridgeService {
  list(): ServerInfo[];
  get(name: string): ServerInfo | undefined;
  reconnect(name: string): Promise<void>;     // force reconnect (clears quarantine)
  reload(): Promise<{ added: string[]; removed: string[]; updated: string[] }>;  // re-read config
  shutdown(name: string): Promise<void>;       // stop server, unregister its tools/skills
}
```

`reload()` is the implementation behind `/mcp reload`. It diffs the new config against the running set:

- New servers: connect and register.
- Removed servers: shut down and unregister (calling the unregister returners stored from `tools:registry.register`).
- Changed servers (any field differs): shutdown + reconnect.

## Slash commands

Provided via the `slash:registry` of `llm-slash-commands` (Spec 8) when present. If that plugin is absent, the commands are not registered (graceful degradation; no hard dependency).

| Command | Behavior |
|---|---|
| `/mcp` | Print a status table of all servers (name, transport, status, tool/prompt counts). |
| `/mcp reload` | Call `mcp:bridge.reload()` and print the diff. |
| `/mcp reconnect <server>` | Force reconnect one server. |
| `/mcp disable <server>` | Mark a server disabled until next reload. |

File watching is intentionally **not** implemented. Reload is explicit. Rationale: MCP server startup can have side effects (subprocess spawn, network auth). Surprise reconnects on every editor save are noisy and risky.

## Status bar integration

If `claude-status-items` (or the openai-compatible reuse of it) is present, the bridge publishes `status:item-update` events with key `mcp` and a value like `mcp: 3/4` (3 connected of 4 configured). On any quarantine, the value flips to `mcp: 3/4 ⚠`. Cleared via `status:item-clear` on `session:end`.

## Lifecycle

| Hook | Action |
|---|---|
| `setup` | Load config, instantiate clients, kick off async connect for each. Register tools/skills as each server reports its capabilities (do not block `setup` on slow servers — registration is incremental). Schedule health-check timer. |
| `session:start` | No-op. |
| `session:end` | Cancel reconnect timers, shut down each client (transport-specific), unregister all tools and skills. Wait up to 10s for graceful shutdown, then force-kill stdio subprocesses. |

Connect is asynchronous and per-server; one slow server cannot block another. Failed initial connects enter the same exponential-backoff retry loop as runtime disconnects.

## Permissions

`tier: "unscoped"`. Justified by:

- Spawns arbitrary subprocesses (`stdio` transport).
- Makes outbound HTTP / SSE requests to user-supplied URLs.
- Registers arbitrary tool schemas the LLM can call.
- Reads user-supplied environment variables for auth.

The plugin's README must include a **Trust** section explaining that MCP servers run as unsandboxed code and that the user is responsible for vetting them. Mention common patterns: prefer `npx`-pinned versions, prefer servers from `@modelcontextprotocol/*` and other reputable scopes, audit `command`+`args` before adding.

## Failure modes and edge cases

| Scenario | Behavior |
|---|---|
| Config file is malformed JSON | Log an error, register no servers, surface via `mcp:bridge.list()` returning empty + a `lastError` on a synthetic entry. Harness still starts. |
| One server's config invalid (bad command, unresolvable env var) | Skip that server, continue with the rest. Log a warning. |
| Server reports a tool with a schema that fails to compile to JSONSchema7 | Skip that single tool with a warning; keep other tools from the server. |
| Two servers both named `foo` (impossible in JSON but possible across merged config files) | Later-loaded file wins; warn about the override. |
| `mcp:<server>:<tool>` collides with a native tool of the same name | Native tool wins (registered first); MCP tool registration fails and is logged. Unlikely given the namespace prefix but defensive. |
| Server's tool/prompt list changes mid-session (MCP `notifications/tools/list_changed`) | Bridge handles the notification by re-listing and reconciling: register new, unregister removed, update changed schemas. Emits a single `skill:available-changed` after the diff. |
| Server returns a non-text content block (image, blob) for a tool result | Wrap in a structured JSON object describing the type; LLMs that can't consume it will see a string description. v0 does not pass binary content through. |
| Tool call cancelled (caller aborts the `signal`) | Bridge sends MCP `notifications/cancelled` if supported; otherwise drops the in-flight request and logs. |
| Stdio process spams stderr | Capture and route to the harness logger at `debug` level; do not pollute the TUI. |

## Testing

Unit tests live in `plugins/llm-mcp-bridge/test/`. Integration tests use a controllable mock MCP server (a small in-process `StdioServerTransport` peer or a fake client transport).

| Test | Validates |
|---|---|
| Config: loads from each location in priority order | File resolution. |
| Config: merges project + user files, project wins on conflict | Merge semantics. |
| Config: rejects invalid server names, missing env vars; continues with others | Resilience. |
| Connect: stdio happy path — subprocess spawns, `initialize` handshake completes, tools registered | Core lifecycle. |
| Connect: SSE happy path — EventSource opens, capabilities listed | SSE transport. |
| Connect: HTTP happy path — single request/response, capabilities listed | HTTP transport. |
| Tool registration: tool names are namespaced `mcp:<server>:<tool>`, tags `["mcp","mcp:<server>"]` | Naming and tags. |
| Tool invoke: registry `invoke('mcp:srv:do', args)` proxies to the mock server and returns its result | Proxy path end-to-end. |
| Tool invoke: server-side error becomes `tool:error` event with the MCP message | Error surfacing. |
| Tool invoke: timeout fires `tool:error` with timeout message after `timeoutMs` | Timeout path. |
| Prompts: MCP prompts register as skills; `skills:registry.load()` invokes `prompts/get` | Prompt → skill mapping. |
| Resources: `read_mcp_resource({ server, uri })` proxies to `resources/read` | Resource tool. |
| Reconnect: kill the stdio subprocess; bridge respawns with backoff and re-registers | Reconnect logic. |
| Reconnect: 5 consecutive failures → quarantined; subsequent invokes fast-fail | Circuit breaker. |
| Reload: `mcp:bridge.reload()` adds new server, removes deleted server, updates changed server; returns correct diff | Reload semantics. |
| Notifications: `tools/list_changed` triggers reconciliation; new tool callable, removed tool unregistered | Dynamic updates. |
| Shutdown: `session:end` unregisters tools/skills and terminates subprocesses (graceful then forced) | Clean shutdown. |
| Collision: native `foo` registered before MCP `foo` (without namespace) — MCP version registers as `mcp:srv:foo` and both coexist | Namespacing. |

A regression suite invokes a real `@modelcontextprotocol/server-everything` (the SDK's reference test server) under stdio for an end-to-end smoke test, gated behind an env var so it does not run in basic CI.

## Interaction with other plugins

| Plugin | Interaction |
|---|---|
| `llm-events` | Consumes `session:end`. Emits `status:item-update`/`status:item-clear`. No new vocabulary. |
| `llm-tools-registry` | Hard dependency. Registers many tools, namespaced. |
| `llm-skills` | Soft dependency. If absent, prompts are not exposed (logged at info level). |
| `llm-slash-commands` | Soft dependency. If absent, `/mcp*` commands are not registered. |
| `llm-driver` | None directly. Driver discovers MCP tools through the shared registry. |
| `llm-agents` | An agent's `toolFilter: { tags: ["mcp:github"] }` selects only that server's tools. Documented in the README. |
| `llm-memory` | None in v0. Future: memory-backed cache of resource reads. |
| Tool dispatch strategies (`llm-native-dispatch`, `llm-codemode-dispatch`) | None — they see registry entries only. |

## Acceptance criteria

- Plugin builds with `bun run build` and passes its own test suite.
- A C-tier harness with `llm-mcp-bridge` enabled and a config pointing at `@modelcontextprotocol/server-filesystem` exposes its tools to the LLM, and a chat turn that asks the model to list a directory completes successfully end-to-end.
- `/mcp` slash command prints a status table.
- `/mcp reload` picks up an added server without restarting the harness.
- Killing a stdio MCP subprocess externally results in automatic reconnection and continued tool availability after the backoff window.
- Marketplace `entries` updated for `llm-mcp-bridge`.
- README documents: dependency on `@modelcontextprotocol/sdk`, the trust model, the config schema, and the resource-via-tool design choice.

## Open questions

- Should MCP prompts that require arguments be exposed as **tools** instead of skills (so the LLM can pass arguments)? Defer until a real prompt-with-args surface emerges in the wild.
- Binary content passthrough for resources (images, PDFs) — likely needs coordination with whatever future multimodal path the harness gains.
- Per-tool allow/deny lists in the config (e.g. expose only `read_*` from a server) — straightforward addition; defer until requested.
- Aggregating MCP server logs into a single harness log stream vs. keeping them per-server — current plan is per-server with a `[mcp:<name>]` prefix.

## Changelog

- 2026-04-30 — Initial draft.
