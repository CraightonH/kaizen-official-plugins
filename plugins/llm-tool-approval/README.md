# llm-tool-approval

Per-tool-call approval gate for the local harness. Subscribes to `tool:before-execute` and prompts the user with four options: Approve Once, Approve Always, Approve Domain Always, Deny. Persists allow/deny rules to project or global config, with a shipped baseline of safe defaults.

## Config

Three sources, all optional. Schema: `{ "allow": string[], "deny": string[] }`.

| Path | Role |
|---|---|
| `<plugin>/defaults.json` | Shipped baseline |
| `~/.kaizen/plugins/llm-tool-approval/config.json` | Global user-managed |
| `<cwd>/.kaizen/plugins/llm-tool-approval/config.json` | Project user-managed; prompt-driven writes go here |

### Match semantics

- Exact tool name (`fs:read_file`).
- Prefix glob (`mcp:github:*`, `fs:*`, or catch-all `*`). `*` is valid only as a trailing segment after `:`, or alone.
- Match rule: any source's `deny` cancels (no prompt); else any source's `allow` passes (no prompt); else prompt.

### Domain derivation

The "Approve Domain Always" option derives from the tool name by taking everything up to the last `:` and appending `:*`. `mcp:github:list_issues` → `mcp:github:*`. Tools with no `:` have no domain; the option is hidden.

## Slash commands

- `/approval:pause` — pause prompting for this session.
- `/approval:resume` — resume.
- `/approval:status` — print pause state, per-source rule counts, effective merged rules, write target.

## Status item

`approval: request` (active) or `approval: paused`.

## Wiring

Manifest order matters: load **after** `llm-hooks-shell` so hooks pre-empt the prompt.

````
"official/llm-hooks-shell@0.1.1",
"official/llm-tool-approval@0.1.0",
````
