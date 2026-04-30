# MCP Bridge — `llm-mcp-bridge` (Spec 11)

**Status:** draft
**Date:** 2026-04-30
**Spec:** 11 of the openai-compatible harness ecosystem
**Depends on:** Spec 0 (`2026-04-30-openai-compatible-foundation-design.md`), Spec 4 (`llm-tools-registry`), Spec 8 (`llm-slash-commands`)
**Tier:** 3 (C-tier harness)

## Goal

Connect kaizen's openai-compatible harness to one or more Model Context Protocol (MCP) servers and own the lifecycle of those connections, so that — once a server is healthy — its tools and resources are re-published into kaizen's plugin registries (`tools:registry`) and become indistinguishable from natively-registered ones.

An MCP server is a separately-running process (or remote endpoint) with its own lifecycle. The bridge's primary job is **owning that lifecycle**: spawning/connecting, handshaking, monitoring health, recovering from failures, and shutting down cleanly. Surfacing tools/resources to the LLM is what falls out of having a healthy connection.

This makes the harness immediately useful: any of the dozens of existing MCP servers (filesystem, github, slack, postgres, etc.) become available with no kaizen-specific glue, just a config file entry.

## Non-goals

- Implementing any MCP server. This plugin is purely a *client* of MCP servers.
- Building a UI for managing MCP servers (configuration is file-based).
- Sandboxing MCP server processes — they run with the same privileges as the harness. This is documented; not enforced.
- Translating MCP resources into a full `memory:store` implementation (Spec 9 owns memory). Resources are exposed via a single `read_mcp_resource` tool in v0.
- Bidirectional bridging (exposing kaizen tools *to* MCP clients). One-way: MCP → kaizen.
- Hot-replacing the MCP SDK or supporting non-standard transports.
- **Surfacing MCP prompts in v0.** Prompts are an optional MCP capability and have a different invocation model from tools; v0 ignores them. See "v1 prompt support (deferred)".

## Server lifecycle (primary responsibility)

The bridge's core job is the lifecycle of each configured MCP server. Everything else (artifact translation, registry registration) is downstream of a healthy connection.

### States

```
disabled ─┐
          ▼
  connecting ──► connected ──► reconnecting ──► quarantined
          ▲           │              │
          └───────────┴──────────────┘
                  (transitions on disconnect / explicit reconnect)
```

- **`disabled`** — config explicitly sets `enabled: false`, or `/mcp:disable <server>` was invoked. No connection attempts.
- **`connecting`** — initial connect or post-quarantine retry in progress.
- **`connected`** — handshake complete, capabilities listed, tools registered.
- **`reconnecting`** — lost connection, in backoff loop.
- **`quarantined`** — exhausted retry budget; will not auto-recover. Manual `/mcp:reconnect` required.

### Phase 1 — Spawning / connecting

| Transport | Connect mechanic |
|---|---|
| `stdio` | Spawn subprocess with `command`, `args`, `env`, `cwd`. Pipe stdin/stdout into the SDK's `StdioClientTransport`. Capture stderr to the harness logger at `debug` level. |
| `sse` | Open an `EventSource` to `url` with `headers`. |
| `http` | No persistent connection. Each MCP request (`initialize`, `tools/list`, `tools/call`, `resources/read`, `ping`) is a fresh HTTP POST to `url` with `headers`. |

Connect is asynchronous and per-server. One slow server cannot block another, and `setup` does not wait on any of them — registration is incremental as each server reaches `connected`.

### Phase 2 — Handshake

Once the transport is open, the bridge issues an MCP `initialize` request:

- Sends client info (`{ name: "kaizen-mcp-bridge", version }`) and the protocol version.
- Receives the server's capabilities object: `{ tools?: {}, resources?: {}, prompts?: {}, ... }`.
- The server is considered `connected` only after `initialize` succeeds.

Capability negotiation in v0:
- `tools: {}` present → call `tools/list`, register each as a kaizen tool.
- `resources: {}` present → register `read_mcp_resource` and `list_mcp_resources` (once globally; their handlers route by `server` argument).
- `prompts: {}` present → **ignored in v0**. Logged at `debug`. Reserved for v1 (see deferred section).
- Any other capability (`roots`, `sampling`, `completion`) → ignored, logged at `debug`.

If `initialize` fails, the connection is treated as a disconnect and enters reconnect logic.

### Phase 3 — Health checks

Periodic liveness probing keeps the bridge's view of each server honest.

| Transport | Health probe |
|---|---|
| `stdio` | Process liveness (`pid` exists / not exited) **plus** periodic MCP `ping` request. |
| `sse` | EventSource readyState check **plus** periodic MCP `ping`. |
| `http` | Periodic MCP `ping` request. Counts toward a circuit breaker; after N consecutive failures the server is marked `unreachable` (treated as a disconnect). |

Default interval: 60s. Configurable per-server via `healthCheckMs`. Health-check failures are treated identically to disconnects: transition to `reconnecting`, kick off backoff.

### Phase 4 — Auto-reconnect with exponential backoff

On unexpected disconnect (stdio process exit code != 0, EventSource close, health-check failure, HTTP circuit-breaker trip):

- **Backoff curve:** 1s, 2s, 4s, 8s, capped at 60s.
- **Retry budget:** 5 attempts. On the 6th failure the server moves to `quarantined`.
- Tools belonging to a quarantined server **remain registered** but their handlers fast-fail with a structured `mcp_server_unavailable` error. This avoids tool-list churn for the LLM.
- A quarantined server is revived only via `/mcp:reconnect <name>`, `/mcp:reload`, or `mcp:bridge.reconnect(name)`.

The backoff state is per-server. Reconnect attempts re-run Phase 1 → Phase 2; on success, the bridge reconciles the new capabilities against its current registrations (re-list tools, register/unregister deltas).

### Phase 5 — Graceful shutdown

Triggered by `session:end` or by `mcp:bridge.shutdown(name)`:

1. Cancel any in-flight reconnect timers and health-check timers.
2. Best-effort send of `notifications/cancelled` for any in-flight tool calls.
3. Close the transport:
   - `stdio` — close stdin, send SIGTERM. If still alive after 5s, send SIGKILL.
   - `sse` — close EventSource.
   - `http` — no-op.
4. Unregister all tools (and v1: prompts) the server contributed, calling the unregister returners stored at registration time.

Total shutdown budget: 10s. Servers that don't terminate gracefully are force-killed.

## Architectural overview

`llm-mcp-bridge` participates in the harness as a capability plugin (Tier 3). On `setup`:

1. Read MCP config file(s).
2. For each enabled server, instantiate an MCP client of the appropriate transport (stdio, SSE, HTTP) and kick off the lifecycle described above (asynchronously).
3. As each server reaches `connected`, translate its capabilities into kaizen registry entries (see "Artifact translation").
4. Provide an `mcp:bridge` service for introspection and runtime reload.
5. Register namespaced slash commands (`/mcp:list`, `/mcp:reload`, `/mcp:reconnect`, `/mcp:disable`) if `slash:registry` is present.
6. Subscribe to `session:end` for clean shutdown.

The plugin owns no event vocabulary additions. All cross-plugin communication is via existing services and events from Spec 0. Tool errors surface through the standard `tool:error` event because MCP-backed handlers go through `tools:registry.invoke` like any other tool.

The bridge is **passive after setup**: once tools are registered, the driver, dispatch strategy, and TUI never touch this plugin again — they just see entries in the registry. The bridge only re-engages for health checks, reconnects, and explicit `/mcp:reload`.

## Configuration

### File locations (resolved in order; first existing file wins, multiple files are merged with later overriding earlier)

1. `<project>/.kaizen/mcp/servers.json` (project-scoped)
2. `~/.kaizen/mcp/servers.json` (user-scoped)
3. Path supplied via env var `KAIZEN_MCP_CONFIG` (CI / one-off override; overrides both)

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

## MCP SDK

**Dependency:** `@modelcontextprotocol/sdk` (the official TypeScript SDK). Pin to a specific minor version in `package.json`. Document the version in the plugin README.

The SDK supplies `StdioClientTransport`, `SSEClientTransport`, and HTTP request helpers; the bridge composes them into the lifecycle state machine described above.

## Artifact translation: MCP capabilities → kaizen registries

Once a server reaches `connected`, the bridge translates its advertised capabilities into kaizen registry entries. This is a downstream consequence of a healthy lifecycle, not a primary responsibility.

### Summary

| MCP artifact | Kaizen registry | Notes |
|---|---|---|
| Tools | `tools:registry` | Namespaced as `mcp:<server>:<toolname>` with `tags: ["mcp", "mcp:<server>"]`. |
| Resources | `tools:registry` (via `read_mcp_resource` and `list_mcp_resources` tools) | Resources are not enumerated; a single read tool plus a list tool keeps the LLM's tool budget small. |
| Prompts | **NOT SURFACED in v0** | Reserved for v1 → `slash:registry` as `/mcp:<server>:<prompt>`. See "v1 prompt support (deferred)". |

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

### Resources (MCP `resources/list`)

Resources are not enumerated into the registry — there can be thousands. Instead a single read tool is registered:

- **name:** `read_mcp_resource`
- **description:** `Read an MCP resource by URI. Use list_mcp_resources to discover URIs.`
- **parameters:** `{ server: string, uri: string }`
- **handler:** routes to the named server's `client.readResource({ uri })`, returns the content.

Plus a discovery tool:

- **name:** `list_mcp_resources`
- **parameters:** `{ server?: string }`
- **handler:** aggregates `client.listResources()` across all healthy servers (or one if `server` given).

### Prompts (v0)

**v0 explicitly skips prompts.** The bridge does not call `prompts/list` and does not register any artifact for prompts. If a server's `initialize` response includes `prompts: {}`, the capability is ignored (logged at `debug`).

Rationale: MCP prompts are user-invoked parameterized message templates, not LLM-decided context loads. They map naturally to **slash commands**, not skills or tools. They are also an *optional* server capability, and most MCP servers in the wild expose only tools. Users who want to guide tool usage should author their own skills via the `llm-skills` plugin.

Prompt support is deferred to v1 — see the next section.

### Roots, sampling, completion

MCP also defines roots, sampling, and completion. v0 ignores them; revisit if user demand surfaces. Document this gap in the README.

## v1 prompt support (deferred)

This section documents the planned v1 design for completeness. **None of this is implemented in v0.**

### Discovery

Only enumerate prompts when the server's `initialize` response advertises `prompts: {}`. Call `prompts/list` to obtain the prompt definitions (each with `name`, `description`, and a list of typed `arguments`).

Subscribe to `notifications/prompts/list_changed` to re-list and reconcile when the server's prompt set changes mid-session.

### Registration

Each prompt becomes a slash command in `slash:registry`:

- **command name:** `mcp:<server>:<prompt>` (note the triple namespacing: the `mcp` plugin prefix, the server name, the prompt name).
- **source:** `"plugin"` (mandates namespacing per Spec 8).
- **description:** the prompt's description.
- **handler:** see below.

### Argument parsing

The slash command accepts arguments using `key=value` syntax matching the prompt's typed arguments:

```
/mcp:github:summarize-pr repo=foo/bar number=42
```

- Keys correspond to the prompt's argument names.
- Values are coerced to the declared types (string, number, boolean).
- Unknown keys produce a usage error printed to the conversation.
- Required arguments missing → usage error.

### Handler

1. Parse `key=value` args into an object matching the prompt's argument schema.
2. Call `client.getPrompt({ name, arguments })` on the owning server.
3. Receive back `messages: Message[]` (the rendered prompt body).
4. Inject those messages into the conversation via the driver's run-conversation entry point (e.g. `driver:run-conversation` or equivalent).

### Lifecycle reconciliation

- On `connected`: list prompts, register slash commands.
- On disconnect / quarantine: **unregister** all `mcp:<server>:*` slash commands (unlike tools, prompts are removed on disconnect — there's no value in keeping a non-functional slash command around).
- On reconnect: re-list and reconcile (register added, unregister removed, replace changed).
- On `notifications/prompts/list_changed`: re-list and reconcile.

### Soft dependency

`llm-slash-commands` (Spec 8) is a **soft** dependency. If absent, the bridge logs at `info` and degrades gracefully — prompts are simply not exposed.

## Service interface — `mcp:bridge`

The plugin's only service. Used by the `/mcp:list` slash command, the status bar, and any debugging hook.

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
  resourceCount: number;     // -1 if not yet listed
  promptCount: number;       // always 0 in v0; populated in v1
  lastError?: string;
  connectedAt?: number;
  reconnectAttempts: number;
}

export interface McpBridgeService {
  list(): ServerInfo[];
  get(name: string): ServerInfo | undefined;
  reconnect(name: string): Promise<void>;     // force reconnect (clears quarantine)
  reload(): Promise<{ added: string[]; removed: string[]; updated: string[] }>;  // re-read config
  shutdown(name: string): Promise<void>;       // stop server, unregister its tools
}
```

`reload()` is the implementation behind `/mcp:reload`. It diffs the new config against the running set:

- New servers: connect and register.
- Removed servers: shut down and unregister (calling the unregister returners stored from `tools:registry.register`).
- Changed servers (any field differs): shutdown + reconnect.

## Slash commands

Provided via the `slash:registry` of `llm-slash-commands` (Spec 8) when present. If that plugin is absent, the commands are not registered (graceful degradation; no hard dependency).

Spec 8 mandates that plugin-registered commands (`source: "plugin"`) MUST be namespaced — the registry rejects bare names. The bridge therefore registers all of its commands under the `mcp:` namespace:

| Command | Behavior |
|---|---|
| `/mcp:list` | Print a status table of all servers (name, transport, status, tool/resource counts). |
| `/mcp:reload` | Call `mcp:bridge.reload()` and print the diff. |
| `/mcp:reconnect <server>` | Force reconnect one server (clears quarantine). |
| `/mcp:disable <server>` | Mark a server disabled until next reload. |

(In v1, prompts contribute additional commands at `/mcp:<server>:<prompt>`, also `source: "plugin"` and namespaced.)

File watching is intentionally **not** implemented. Reload is explicit. Rationale: MCP server startup can have side effects (subprocess spawn, network auth). Surprise reconnects on every editor save are noisy and risky.

## Status bar integration

If `claude-status-items` (or the openai-compatible reuse of it) is present, the bridge publishes `status:item-update` events with key `mcp` and a value like `mcp: 3/4` (3 connected of 4 configured). On any quarantine, the value flips to `mcp: 3/4 ⚠`. Cleared via `status:item-clear` on `session:end`.

## Lifecycle hooks

| Hook | Action |
|---|---|
| `setup` | Load config, instantiate clients, kick off async connect for each (Phase 1 → Phase 2). Tools register incrementally as servers report capabilities — `setup` does not block on slow servers. Schedule health-check timers. |
| `session:start` | No-op. |
| `session:end` | Run Phase 5 (graceful shutdown) for every server. Cancel reconnect/health timers, close transports, unregister tools. Wait up to 10s for graceful shutdown, then force-kill stdio subprocesses. |

Failed initial connects enter the same exponential-backoff retry loop as runtime disconnects (Phase 4).

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
| Server's tool list changes mid-session (MCP `notifications/tools/list_changed`) | Bridge handles the notification by re-listing and reconciling: register new, unregister removed, update changed schemas. |
| Server returns a non-text content block (image, blob) for a tool result | Wrap in a structured JSON object describing the type; LLMs that can't consume it will see a string description. v0 does not pass binary content through. |
| Tool call cancelled (caller aborts the `signal`) | Bridge sends MCP `notifications/cancelled` if supported; otherwise drops the in-flight request and logs. |
| Stdio process spams stderr | Capture and route to the harness logger at `debug` level; do not pollute the TUI. |
| Server advertises `prompts: {}` in v0 | Ignored; logged at `debug`. No prompt enumeration occurs. |

## Testing

Unit tests live in `plugins/llm-mcp-bridge/test/`. Integration tests use a controllable mock MCP server (a small in-process `StdioServerTransport` peer or a fake client transport).

| Test | Validates |
|---|---|
| Config: loads from each location in priority order (`~/.kaizen/mcp/servers.json`, `<project>/.kaizen/mcp/servers.json`, `KAIZEN_MCP_CONFIG`) | File resolution. |
| Config: merges project + user files, project wins on conflict | Merge semantics. |
| Config: rejects invalid server names, missing env vars; continues with others | Resilience. |
| Lifecycle: stdio happy path — subprocess spawns, `initialize` handshake completes, tools registered | Phases 1–2. |
| Lifecycle: SSE happy path — EventSource opens, capabilities listed | SSE transport. |
| Lifecycle: HTTP happy path — single request/response, capabilities listed | HTTP transport. |
| Lifecycle: health check fires `ping`; failure transitions to `reconnecting` | Phase 3. |
| Lifecycle: kill stdio subprocess; bridge respawns with backoff (1s, 2s, 4s, 8s, 60s cap) | Phase 4 backoff curve. |
| Lifecycle: 5 consecutive failures → `quarantined`; subsequent invokes fast-fail with `mcp_server_unavailable` | Quarantine. |
| Lifecycle: `/mcp:reconnect` clears quarantine and re-runs Phase 1 | Manual recovery. |
| Lifecycle: `session:end` SIGTERMs stdio; force-kills after 5s; unregisters tools | Phase 5. |
| Tool registration: tool names are namespaced `mcp:<server>:<tool>`, tags `["mcp","mcp:<server>"]` | Naming and tags. |
| Tool invoke: registry `invoke('mcp:srv:do', args)` proxies to the mock server and returns its result | Proxy path end-to-end. |
| Tool invoke: server-side error becomes `tool:error` event with the MCP message | Error surfacing. |
| Tool invoke: timeout fires `tool:error` with timeout message after `timeoutMs` | Timeout path. |
| Resources: `read_mcp_resource({ server, uri })` proxies to `resources/read` | Resource tool. |
| Prompts (v0): server advertising `prompts: {}` does NOT trigger `prompts/list` and registers no slash commands | v0 skip behavior. |
| Slash commands: `/mcp:list`, `/mcp:reload`, `/mcp:reconnect`, `/mcp:disable` register with `source: "plugin"` and namespaced names | Spec 8 conformance. |
| Reload: `mcp:bridge.reload()` adds new server, removes deleted server, updates changed server; returns correct diff | Reload semantics. |
| Notifications: `tools/list_changed` triggers reconciliation; new tool callable, removed tool unregistered | Dynamic updates. |
| Collision: native `foo` registered before MCP `foo` (without namespace) — MCP version registers as `mcp:srv:foo` and both coexist | Namespacing. |

A regression suite invokes a real `@modelcontextprotocol/server-everything` (the SDK's reference test server) under stdio for an end-to-end smoke test, gated behind an env var so it does not run in basic CI.

## Interaction with other plugins

| Plugin | Interaction |
|---|---|
| `llm-events` | Consumes `session:end`. Emits `status:item-update`/`status:item-clear`. No new vocabulary. |
| `llm-tools-registry` | Hard dependency. Registers many tools, namespaced. |
| `llm-slash-commands` | Soft dependency. If absent, `/mcp:*` commands are not registered. In v1, also the registration target for prompt slash commands. |
| `llm-skills` | None in v0. (Earlier drafts mapped MCP prompts to skills; that mapping has been removed.) |
| `llm-driver` | None directly in v0. Driver discovers MCP tools through the shared registry. In v1, prompt slash commands invoke `driver:run-conversation` to inject `prompts/get` results. |
| `llm-agents` | An agent's `toolFilter: { tags: ["mcp:github"] }` selects only that server's tools. Documented in the README. |
| `llm-memory` | None in v0. Future: memory-backed cache of resource reads. |
| Tool dispatch strategies (`llm-native-dispatch`, `llm-codemode-dispatch`) | None — they see registry entries only. |

## Acceptance criteria

- Plugin builds with `bun run build` and passes its own test suite.
- A C-tier harness with `llm-mcp-bridge` enabled and a config at `~/.kaizen/mcp/servers.json` pointing at `@modelcontextprotocol/server-filesystem` exposes its tools to the LLM, and a chat turn that asks the model to list a directory completes successfully end-to-end.
- `/mcp:list` slash command prints a status table.
- `/mcp:reload` picks up an added server without restarting the harness.
- Killing a stdio MCP subprocess externally results in automatic reconnection and continued tool availability after the backoff window.
- A server advertising `prompts: {}` is connected successfully and its tools are usable; no prompt-related slash commands are registered (v0 behavior).
- Marketplace `entries` updated for `llm-mcp-bridge`.
- README documents: dependency on `@modelcontextprotocol/sdk`, the trust model, the config schema (including the `~/.kaizen/mcp/servers.json` path), the resource-via-tool design choice, and the v0 prompt-skip behavior.

## Open questions

- Binary content passthrough for resources (images, PDFs) — likely needs coordination with whatever future multimodal path the harness gains.
- Per-tool allow/deny lists in the config (e.g. expose only `read_*` from a server) — straightforward addition; defer until requested.
- Aggregating MCP server logs into a single harness log stream vs. keeping them per-server — current plan is per-server with a `[mcp:<name>]` prefix.
- v1 prompt UX: should `/mcp:<server>:<prompt>` be flat, or should we generate a `/mcp:<server>` group command that dispatches to sub-prompts? Defer until v1 implementation begins.

## Changelog

- 2026-04-30 — Initial draft.
- 2026-04-30 — Substantive rewrite:
  - Reframed around server lifecycle as the primary responsibility (spawn/connect → handshake → health → reconnect/backoff → shutdown). Artifact translation moved downstream.
  - **v0 skips MCP prompts entirely.** Removed the prior "MCP prompts → `skills:registry`" mapping (incorrect: prompts are user-invoked, not LLM-pulled context).
  - Added "v1 prompt support (deferred)" section documenting future mapping to `slash:registry` as `/mcp:<server>:<prompt>` with `key=value` argument parsing, `prompts/get` handler, lifecycle reconciliation, and soft dependency on `llm-slash-commands`.
  - Renamed slash commands to namespaced form per Spec 8: `/mcp` → `/mcp:list`, `/mcp reload` → `/mcp:reload`, `/mcp reconnect` → `/mcp:reconnect`, `/mcp disable` → `/mcp:disable`.
  - Migrated config paths: `~/.kaizen-llm/mcp-servers.json` → `~/.kaizen/mcp/servers.json`; `<project>/.kaizen-llm/mcp.json` → `<project>/.kaizen/mcp/servers.json`. `KAIZEN_MCP_CONFIG` env var unchanged.
  - Updated artifact translation table to reflect v0 (prompts row marked NOT SURFACED).
  - Dependencies updated: replaced Spec 7 (`llm-skills`) with Spec 8 (`llm-slash-commands`) since the bridge no longer touches skills.
