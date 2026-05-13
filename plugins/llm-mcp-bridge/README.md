# llm-mcp-bridge

Owns the lifecycle of one or more Model Context Protocol (MCP) servers and re-publishes their tools and resources into kaizen's registries so the LLM sees them as native tools.

## What it does

- Reads MCP server config from disk (project, user, and `${KAIZEN_MCP_CONFIG}` paths) and resolves env interpolation (`${env:VAR}`).
- For each enabled server, runs a state machine: `connecting` → `connected` → `reconnecting` → `quarantined` (or `disabled`).
  - **Connect:** stdio subprocess (`StdioClientTransport`), SSE (`SSEClientTransport`), or streamable HTTP (`StreamableHTTPClientTransport`).
  - **Handshake:** MCP `initialize`, then `tools/list` + `resources/list` based on advertised capabilities.
  - **Health:** periodic MCP `ping` every `healthCheckMs` (default 60s); failure ⇒ reconnect.
  - **Reconnect:** exponential backoff 1s/2s/4s/8s/16s, capped at 60s. After 5 consecutive failures the server is **quarantined**; tool handlers fast-fail with `mcp_server_unavailable: <name>` until a manual reconnect.
  - **Shutdown:** on harness end, close transports, SIGTERM stdio (force-kill after 5s), unregister tools.
- Translates server capabilities into registry entries:
  - **Tools** — each MCP tool registered as `mcp:<server>:<toolname>` with tags `["mcp", "mcp:<server>"]`. MCP `inputSchema` is used verbatim as the JSONSchema7 `parameters`. Text-only result content is flattened to a string; mixed/binary content passes through as the structured array.
  - **Resources** — not enumerated. Two global tools are registered once: `read_mcp_resource({ server, uri })` and `list_mcp_resources({ server? })`.
  - **Prompts** — **ignored in v0** (logged at debug). Reserved for v1 → namespaced slash commands.
- Reconciles tool sets on reconnect and on `notifications/tools/list_changed` (register added, unregister removed, replace changed schemas).
- Pinned SDK: `@modelcontextprotocol/sdk@1.10.1`.

## Wiring

### Provides

**Service** — `mcp:bridge`

```typescript
type ServerStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "quarantined"
  | "disabled";

interface ServerInfo {
  name: string;
  transport: "stdio" | "sse" | "http";
  status: ServerStatus;
  toolCount: number;
  resourceCount: number;     // -1 until first listing succeeds
  promptCount: number;       // always 0 in v0
  lastError?: string;
  connectedAt?: number;
  reconnectAttempts: number;
}

interface McpBridgeService {
  list(): ServerInfo[];
  get(name: string): ServerInfo | undefined;
  reconnect(name: string): Promise<void>;     // clears quarantine
  reload(newConfig?: Map<string, ResolvedServerConfig>): Promise<{ added: string[]; removed: string[]; updated: string[] }>;
  shutdown(name: string): Promise<void>;       // stop one server
}
```

Semantics:
- `list()` returns one `ServerInfo` per configured server (including `disabled`/`quarantined` ones).
- `reconnect(name)` aborts current timers, closes the client, resets the attempt counter, and re-runs Phase 1 → Phase 2.
- `reload()` diffs the new config against the running set: shuts down removed servers, starts new ones, restarts changed ones (any field differs ⇒ shutdown + start).
- Tools belonging to a quarantined server stay registered; their handlers throw `mcp_server_unavailable: <name>`.

**Tools** registered into `tools:registry`:

| Tool name | Source | Notes |
|---|---|---|
| `mcp:<server>:<toolname>` | each MCP tool from each connected server | `source: { kind: "mcp", server: <name> }`; tags `["mcp", "mcp:<server>"]` |
| `read_mcp_resource` | bridge | `source: { kind: "local" }`; `{ server: string, uri: string }` |
| `list_mcp_resources` | bridge | `source: { kind: "local" }`; `{ server?: string }` |
| `mcp:list` | bridge | LLM-callable peer of `/mcp:list`; returns `ServerInfo[]` |
| `mcp:reload` | bridge | LLM-callable peer of `/mcp:reload`; returns the diff |
| `mcp:reconnect` | bridge | LLM-callable peer of `/mcp:reconnect`; `{ server: string }` |
| `mcp:disable` | bridge | LLM-callable peer of `/mcp:disable`; `{ server: string }` |

The bridge declares `source.kind = "mcp"` (with `server: string`) only for tools brokered from a real MCP server. The control tools above register as `{ kind: "local" }` because they are implemented by the bridge itself, not brokered. This honors the open `ToolSource` shape owned by `llm-tools-registry` (see `docs/polish/llm-tools-registry-contract-change.md`).

**Slash commands** registered into `slash:registry` (when present), all with `source: "plugin"` (Spec 8 namespacing required):

| Command | Behavior |
|---|---|
| `/mcp:list` | Print a status table (name, transport, status, tools, resources, lastError). |
| `/mcp:reload` | Re-read config from disk and apply the diff. |
| `/mcp:reconnect <server>` | Force reconnect one server (clears quarantine). |
| `/mcp:disable <server>` | Shutdown one server until next `/mcp:reload`. |

### Consumes

**Services**
- `tools:registry` — **optional.** Without it the bridge installs a no-op `mcp:bridge` and registers nothing.
- `events:vocabulary` — consumed for boot-order guarantee (optional, no useService call).
- `slash:registry` — **optional.** If absent, the `/mcp:*` commands are not registered; tool surfacing still works.

**Events listened to**
- `harness:end` — runs graceful shutdown for every server (cancel timers, close transports, unregister tools, force-kill stdio after 5s).

**Events emitted**
- `status:item-update` — `{ key: "mcp", value: "<connected>/<total>[ ⚠]" }`. Refreshed on a 5s tick. The warning marker is appended whenever any server is quarantined.
- `status:item-clear` — `{ key: "mcp" }`. Emitted when there are zero configured servers and on `harness:end`.
- `conversation:system-message` — `{ content: string }`. Emitted from `/mcp:*` slash command handlers to write status output back to the conversation.
- `tool:error` — emitted indirectly: MCP-backed tool handlers throw, and `tools:registry.invoke` surfaces the error through the standard event. The bridge does not emit `tool:error` itself.

This plugin defines no event vocabulary of its own.

## Configuration

Files (resolved in order; later overrides earlier on key collisions, with a warning):

1. `~/.kaizen/mcp/servers.json` (user)
2. `<cwd>/.kaizen/mcp/servers.json` (project)
3. `${KAIZEN_MCP_CONFIG}` (full path; CI/one-off)

Absence of all three is not an error.

### Schema

Mirrors Claude Code's MCP config so entries copy across:

```jsonc
{
  "servers": {
    "filesystem": {
      "transport": "stdio",                                       // optional; inferred
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem@1.0.0", "/Users/me/code"],
      "env": { "DEBUG": "1" },
      "cwd": "/Users/me",
      "enabled": true,
      "timeoutMs": 30000,
      "healthCheckMs": 60000
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

Inference rules:
- `command` present ⇒ `stdio`.
- `url` present, no `command` ⇒ `http`.
- `"sse"` must be set explicitly.

`${env:VAR}` is interpolated at load time on every string value. Missing vars skip that one server with a warning; others continue.

Server names must match `/^[a-z0-9][a-z0-9_-]*$/` because they appear in tool names.

## Permissions

`tier: unscoped`. The bridge spawns arbitrary subprocesses (stdio transport), opens user-supplied URLs (sse/http), reads env vars for auth, and registers arbitrary tool schemas the LLM can invoke.

## Trust

MCP servers run with the **same privileges as the harness** — there is no sandboxing. Before adding a server, audit:

- `command` and `args` (pin `npx` packages with `@<version>` to prevent silent upgrades).
- The package's publisher; prefer `@modelcontextprotocol/*` and other reputable scopes.
- Env vars granted via `env`.
