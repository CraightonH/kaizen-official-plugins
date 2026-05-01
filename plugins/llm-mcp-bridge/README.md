# llm-mcp-bridge

Bridge MCP (Model Context Protocol) servers into the kaizen openai-compatible
harness. v0 surfaces **tools and resources only** — prompts are deferred to v1.

Pinned SDK: `@modelcontextprotocol/sdk@1.10.1`

## Dependencies

- Hard: `@modelcontextprotocol/sdk@1.10.1`, `llm-events`,
  `tools:registry` (provided by `llm-tools-registry`).
- Soft: `slash:registry` (provided by `llm-slash-commands`). If absent,
  `/mcp:*` commands are not registered; tool surfacing still works.

## Trust

MCP servers run with the **same privileges as the harness**. There is no
sandboxing. Before adding a server, audit:

- `command` and `args` (especially `npx ...` packages — pin a specific version
  via `@<version>` to prevent silent upgrades).
- The scope of the package; prefer `@modelcontextprotocol/*` and other vetted
  publishers.
- Any environment variables you grant via `env`.

## Configuration

The bridge reads, in this priority order (later sources override earlier):

1. `~/.kaizen/mcp/servers.json` (user-scoped)
2. `<project>/.kaizen/mcp/servers.json` (project-scoped, overrides user)
3. `${KAIZEN_MCP_CONFIG}` (full path; overrides both, intended for CI)

If no file exists, the plugin logs an info line and registers zero MCP tools.

### Schema

The format mirrors Claude Code's MCP config so entries copy across:

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

- `transport` is inferred when omitted: `command` => `stdio`, `url` only => `http`.
  Use `"sse"` explicitly for Server-Sent-Events transports.
- `${env:VAR}` is interpolated at load time. If `VAR` is unset, the server is
  skipped with a warning and the rest continue.
- Server names must match `/^[a-z0-9][a-z0-9_-]*$/` because they participate in
  tool names (`mcp:<server>:<tool>`).

## What gets registered

- **Tools.** Each MCP tool the server reports is registered as
  `mcp:<server>:<toolname>` with tags `["mcp", "mcp:<server>"]`. The MCP
  `inputSchema` is used verbatim as the kaizen `parameters` JSONSchema.
- **Resources** — _not enumerated._ Two universal tools are registered once
  globally:
  - `read_mcp_resource({ server, uri })` proxies to `resources/read`.
  - `list_mcp_resources({ server? })` aggregates `resources/list` across all
    healthy servers (or one).
  This keeps the LLM's tool budget bounded regardless of how many resources a
  server exposes.
- **Prompts** — _not surfaced in v0._ If a server's `initialize` advertises
  `prompts: {}`, the capability is ignored (logged at debug). v1 will register
  prompts as `/mcp:<server>:<prompt>` slash commands; **not** as skills.

## Slash commands

If `slash:registry` is provided by `llm-slash-commands`, four namespaced
plugin commands are registered (Spec 8 mandates the namespace prefix):

- `/mcp:list` — status table of all configured servers.
- `/mcp:reload` — re-read config from disk and apply the diff (no file watch).
- `/mcp:reconnect <server>` — force reconnect; clears quarantine.
- `/mcp:disable <server>` — shut down and unregister tools until next reload.

## Lifecycle

Each server is owned end-to-end by the bridge:

1. **Connect** — spawn subprocess (stdio) / open EventSource (sse) / nothing
   persistent (http).
2. **Handshake** — `initialize`; capabilities recorded.
3. **Health** — `ping` every `healthCheckMs` (default 60s). Failures are
   treated as disconnects.
4. **Reconnect** — exponential backoff `1s, 2s, 4s, 8s, 16s` capped at 60s; 5
   attempts before quarantine.
5. **Shutdown** — on `session:end`, SIGTERM stdio (force-kill after 5s), close
   transports, unregister tools.

Tools registered by a quarantined server **remain in the registry** with their
handlers fast-failing (`mcp_server_unavailable: <name>`) — this avoids
tool-list churn for the LLM. `/mcp:reconnect <name>` revives the server.

## Status bar

If a status-items service is present, the bridge publishes
`status:item-update { key: "mcp", value: "mcp: 3/4" }` (warning marker
appended on quarantine).

## Testing

```sh
bun test plugins/llm-mcp-bridge/
```

The integration test against the SDK's reference server is gated:

```sh
KAIZEN_INTEGRATION=1 bun test plugins/llm-mcp-bridge/test/integration/
```

## v1 plan (deferred)

Prompts will register into `slash:registry` as `/mcp:<server>:<prompt>` with
`key=value` argument parsing, calling `prompts/get` and injecting the rendered
messages via the driver's `runConversation`. See Spec 11 for the design.
