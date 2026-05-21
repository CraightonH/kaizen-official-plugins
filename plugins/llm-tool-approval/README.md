# llm-tool-approval

Per-tool-call approval gate for the local harness. Subscribes to `tool:before-execute` and prompts the user with Approve Once, Approve Always, Approve Pattern Always, Approve Domain Always, and Deny (options shown as relevant to the call). Persists allow/deny rules to project or global config, with a shipped baseline of safe defaults. A bash-specific safety override force-prompts on commands containing shell control characters.

## Config

Storage is mediated by `kaizen-config`, which keeps a single file per harness rather than one per plugin. The plugin's section sits under `plugins["llm-tool-approval"]` with shape `{ "allow": string[], "deny": string[] }`.

Three layers, all optional, merged in this order (later layers win per-field):

| Layer | Path | Role |
|---|---|---|
| Defaults | `<plugin>/defaults.json` (shipped) | Baseline rules |
| Home | `~/.kaizen/harnesses/<harnessKey>/config.json` | Per-user, applies anywhere that harness runs |
| Project | `<cwd>/.kaizen/harnesses/<harnessKey>/config.json` | Per-directory; **prompt-driven writes go here** |

`<harnessKey>` is derived from the harness identity by `kaizen-config` — e.g. a marketplace ref `official/local@0.1.0` → `official_local`, a local file `./harnesses/local.json` → `local_local`. Run `/approval:status` to see the exact resolved paths for your current session.

Writes from the prompt only append the new entry to the **project** layer; defaults and home-scope entries are not re-stamped into the project file.

### Match semantics

- Exact tool name (`fs:read_file`).
- Prefix glob (`mcp:github:*`, `fs:*`, or catch-all `*`). `*` is valid only as a trailing segment after `:`, or alone.
- Argument pattern (`tool(pattern)`). The rule fires when the tool name matches **and** at least one string-typed leaf in the call's `args` glob-matches the pattern. Supported pattern metacharacters: `*` (any chars including `/`), `?` (one char), `[abc]` (character class). No escapes in v1.
- Resolution order: `deny → bash-safety → allow → prompt`. Deny is absolute. A bash-safety hit forces a prompt and overrides `allow` (but not `deny`).

`tool(pattern)` matches against **any** string leaf in `args`. For tools with multiple string fields this can over-match (rule fires when only one of several strings matches the pattern); this is acceptable for an approval gate where the failure mode is an unnecessary auto-approval within the tool-name scope.

### Bash safety

`bash` commands containing shell control characters are never auto-approved — the gate forces a prompt and shows the reason. Triggers (first match reported):

| Detected in `args.command` | Reason |
|---|---|
| `\n` or `\r` | multiline command |
| `` ` `` | backtick command substitution — unable to inspect |
| `$(` | command substitution `$(…)` — unable to inspect |
| `&&` or `\|\|` | conditional chaining (`&&` / `\|\|`) |
| `;` | command separator `;` |
| `\|` (plain pipe, not `\|\|`) | pipe `\|` |
| trailing `&` | background execution `&` |

Quoted occurrences are **not** exempted — `bash -c "echo 'ls; rm'"` flags. Over-flagging is the safer default. Safety-flagged prompts only offer **Approve Once** and **Deny**; the "always"-flavored options are hidden because no sensible rule could persist a chained command.

### Domain derivation

The "Approve Domain Always" option derives from the tool name by taking everything up to the last `:` and appending `:*`. `mcp:github:list_issues` → `mcp:github:*`. Tools with no `:` have no domain; the option is hidden.

### Approve Pattern Always

When the call has string-typed args and no rule has matched, the prompt offers an extra option, **Approve Pattern Always**, with a suggested pattern derived from the call (e.g. `bash git status` → `git *`, `web_search https://github.com/x/y` → `*github.com/*`, `read /Users/chancock/foo` → `/Users/chancock/*`).

- **Enter on the highlighted row** persists the suggested pattern as-is.
- **Tab** opens an inline editor pre-filled with the suggestion. Edit and **Enter** to persist your version; **clear and Enter** to fall back to Approve Once (no persist).

The persisted rule is `tool(pattern)` written to the project layer (same target as the other "always" options).

## Slash commands

- `/approval:pause` — pause prompting for this session.
- `/approval:resume` — resume.
- `/approval:status` — print pause state, per-source rule counts, effective merged rules, write target.

## Status item

`approval: request` (active) or `approval: paused`.

## Wiring

Manifest order matters: load **after** `llm-hooks-shell` so hooks pre-empt the prompt.

````
"official/llm-hooks-shell@0.1.2",
"official/llm-tool-approval@0.2.2",
````
