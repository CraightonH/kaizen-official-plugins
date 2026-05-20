# kaizen-config

Harness-scoped plugin configuration store for the local harness. Provides the `config:store` service that lets peer plugins register typed configuration fields and persist them per-harness, with home and project layers merged on read and env-var overrides winning over both.

## Service

Provides `config:store` (contract owned by `llm-contracts`):

- `register(pluginName, schema)` — declare typed fields and optional env-var mappings.
- `get(pluginName)` / `get(pluginName, field)` — read merged value (home + project + env).
- `set(pluginName, field, value)` — atomic write to the project layer by default.
- `subscribe(pluginName, cb)` — fire when on-disk values change (debounced).

Validation runs on every load and every write. A validation failure on boot logs and falls back to defaults; a failure on `set()` rejects the call.

## Storage

Two JSON files per harness, identified by `harnessKey(harness)`:

| Path | Layer |
|---|---|
| `~/.kaizen/harnesses/<harnessKey>/config.json` | Home (user-global) |
| `<cwd>/.kaizen/harnesses/<harnessKey>/config.json` | Project (project keys win over home) |

Env-var values, declared per-field via `register()`, beat all file layers.

Writes are atomic (tmp + rename). The plugin watches both files and notifies subscribers on change.

## Slash commands

When `slash:registry` is available, the plugin registers `/config` commands for inspecting and editing the merged config and the underlying files in `$EDITOR`. If the registry isn't available, `/config` is silently disabled and the service still works.

## Permissions

Scoped tier:
- `fs.read` / `fs.write`: `~/.kaizen/harnesses/**`, `./.kaizen/harnesses/**`.

The plugin uses `node:fs` and `node:child_process` directly (for `fs.watch` and `spawn $EDITOR`). The runtime enforcer gates these by the declared fs paths above.
