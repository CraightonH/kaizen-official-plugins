# Working in `llm-mcp-bridge`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts          Plugin lifecycle: consumes `config:store`, registers schema, wires
                  service, registers slash commands, emits status-bar events, hooks
                  `harness:end` for shutdown. The only file that touches `ctx`.
servers.ts        resolveServers(servers, env) → { servers, warnings }. Pure logic.
                  Takes the `servers` map loaded by `config:store` and applies
                  plugin-specific transforms: `${env:VAR}` interpolation, server-name
                  validation, transport inference, defaults. Owns `ServerConfig` and
                  `ResolvedServerConfig` types. The home/project file paths and JSON
                  loading live in `llm-config`, not here.
client.ts         createClient(cfg, deps) → { client, pid }. Wraps the official
                  @modelcontextprotocol/sdk Client + transport (stdio/sse/http) into the
                  internal `McpClientLike` surface. Stderr from stdio is piped to log
                  with `[mcp:<name>]` prefix.
lifecycle.ts      ServerLifecycle — owns one server's state machine (connecting,
                  connected, reconnecting, quarantined, disabled). Handles connect,
                  handshake, capability detection, health checks, backoff retries,
                  tool reconciliation, shutdown.
service.ts        makeBridgeService(deps) → InternalBridge. Composes lifecycles into the
                  public `mcp:bridge` service. Registers the two global resource tools
                  (`read_mcp_resource`, `list_mcp_resources`) once.
registration.ts   toToolRegistration() — translates one MCP tool to a kaizen registry
                  schema + handler (with timeout/abort plumbing). Plus the two
                  resource-tool factories. Pure.
backoff.ts        computeBackoffMs(attempt) and RETRY_BUDGET. Pure constants/math.
names.ts          kaizenToolName, kaizenToolTags, isValidServerName. Pure.
slash.ts          registerSlashCommands(slash, bridge, reloadFromDisk, log). Pure
                  factory; no state. Returns disposers (currently unused).
public.d.ts       Exported types — ServerStatus, ServerInfo, McpBridgeService.
                  The canonical service contract.
```

Boundaries:
- `lifecycle.ts` and `service.ts` are the only stateful modules. Everything else is pure.
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- `lifecycle.ts` never touches `ctx` directly — the service injects `RegistryLike` and a `log` callback.
- Tests live alongside modules in `test/`. Integration tests against the SDK reference server are gated behind `KAIZEN_INTEGRATION=1`.

## Invariants

- **Lifecycle owns the registry handle.** Tool unregister functions returned by `tools:registry.register` are stored on `ServerLifecycle.registered` and called on shutdown / reconciliation. Never store them anywhere else.
- **Quarantine does not unregister tools.** Tools belonging to a quarantined server stay registered; their handlers throw `mcp_server_unavailable: <name>`. This avoids tool-list churn for the LLM. If you change this, audit driver caches.
- **Tool names are namespaced.** Always `mcp:<server>:<toolname>`, tags `["mcp", "mcp:<server>"]`. Two servers with a tool named `search` coexist as `mcp:github:search` and `mcp:filesystem:search`.
- **Setup never blocks on a slow server.** Each lifecycle's `start()` returns immediately; connect runs async. One slow server cannot delay another, and `setup` does not await any of them.
- **Shutdown is idempotent.** `ServerLifecycle.shutdown()` guards on `shutdownCalled`. Second calls are no-ops. The 5s race in `shutdown()` ensures we don't hang on misbehaving transports.
- **Backoff curve is fixed.** 1s/2s/4s/8s/16s, capped at 60s; `RETRY_BUDGET = 5`. Tests assert this. If you change it, update both `backoff.ts` and the README.
- **Prompts are ignored in v0.** A `prompts: {}` capability logs at debug and registers nothing. Do not add `prompts/list` calls in the v0 path; defer to the v1 design (slash commands, not skills).
- **Resources are not enumerated into the registry.** Two universal tools route by `server` argument. Don't change this without a tool-budget conversation — some servers expose thousands of resources.
- **Config interpolation is at load time, deep, and skip-on-miss.** Missing `${env:VAR}` skips one server with a warning; others continue. Do not throw on a single missing var. This is plugin-specific interpolation in `servers.ts::resolveServers`, distinct from the `envVars` overrides that `config:store` applies to top-level keys.
- **Control tools register as `kind: "local"`, not `kind: "mcp"`.** `read_mcp_resource` and `list_mcp_resources` (in `service.ts`) are registered with `source: { kind: "local" }`. They are *implemented* by this plugin, not brokered from any MCP server, so they belong in the consumer's "local" presentation bucket (e.g. `kaizen.tools.*` in `llm-codemode`, not `kaizen.mcp.*`). The `mcp` kind is reserved for tools that came from a real MCP server and carry a `server: string`. After the `ToolSource` open-shape refactor (`llm-tools-registry@0.3.0`), a future change here could introduce a dedicated provenance kind (e.g. `mcp-bridge-control`) without coordinating a registry version bump — but only do so if a downstream consumer needs to distinguish these tools from genuinely local plugin tools.

## Adding a new transport

1. Add a branch in `client.ts::createClient` using the relevant SDK transport class.
2. Extend `Transport` in `config.ts` and `inferTransport()` if there's an inference rule.
3. Update `package.json` only if a new SDK subpath is required.
4. Add a happy-path test in `test/lifecycle.test.ts` using a mock client (see `test/mockServer.ts`).

## Editing the lifecycle state machine

`ServerLifecycle` is the heart of this plugin. Keep transitions in one place — `setStatus()` — so `onStatusChange` callbacks fire exactly once per change. The status set is:

```
disabled       — explicit `enabled: false` or post-`shutdown()` of a started server
connecting     — initial connect or post-quarantine retry
connected      — initialize succeeded; capabilities listed; tools registered
reconnecting   — disconnect detected, in backoff
quarantined    — exhausted retry budget; manual revival only
```

`scheduleRetry()` increments the attempt counter *before* checking the budget; the 5th failure quarantines. The `attempts` field resets to 0 on `forceReconnect()` and on a successful `connected` transition.

## Reconciliation

`ServerLifecycle.reconcileTools()` runs:
- On initial `connected`.
- On every `notifications/tools/list_changed`.
- On every reconnect after quarantine recovery.

It computes a delta: register added, replace changed (different description or parameters), unregister removed. If you add prompt support in v1, mirror this exact pattern in a `reconcilePrompts()` against `slash:registry`.

## Testing

```bash
cd plugins/llm-mcp-bridge && bun test
```

Tests use `bun:test` only — no external mocking framework. `test/mockServer.ts` provides a controllable `McpClientLike` peer for lifecycle tests.

Integration tests against `@modelcontextprotocol/server-everything` are gated:

```bash
KAIZEN_INTEGRATION=1 bun test plugins/llm-mcp-bridge/test/integration/
```

## Local deploy

Build from the source directory (where workspace deps resolve), then sync into the install dir:

```bash
PLUGIN=llm-mcp-bridge
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
