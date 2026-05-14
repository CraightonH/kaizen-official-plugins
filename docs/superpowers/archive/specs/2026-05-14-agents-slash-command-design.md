# Agents Visibility Slash Commands (`/agents:list`, `/agents:show`)

**Status:** approved design, awaiting plan
**Scope:** `plugins/llm-agents` only — no contract changes, no event changes, no driver changes

## Goal

Give the openai-compatible harness's user direct, read-only visibility into the
agent registry that backs the `dispatch_agent` tool. Two plugin-source slash
commands:

- `/agents:list` — catalog of every registered agent.
- `/agents:show <name>` — full detail for one agent (description, scope, source
  path, tool filter, system prompt).

The model already sees the registry via the `prompt:registry` Available-agents
section and the `dispatch_agent` tool. The user has had no equivalent surface.

## Non-goals

- Runtime visibility into active dispatches (turn tree, depth, currently
  running sub-agent). The turn tracker is cleared on `turn:end`, so by the
  time a user can type a slash command between turns there is rarely anything
  to show. Belongs in a future streaming TUI panel, not a slash command.
- Per-dispatch logs, message inspection, or cancellation. Out of scope for v1.
- Registering or editing agents via the slash interface. Agents are loaded
  from disk (`~/.kaizen/agents/`, `.kaizen/agents/`) or registered
  programmatically via `agents:registry.register()`. Slash commands stay
  read-only.

## Architecture

No new contract; no `llm-contracts` change. `llm-agents` gains a topo-hint
optional dependency on `slash:registry` and registers two plugin-source slash
commands during `setup()`. Pure-factory handlers live in a new `slash.ts`;
`index.ts` does the wiring and teardown.

Touches:

- `plugins/llm-agents/index.ts` — add `slash:registry` to `services.consumes`,
  look up the service inside a `try`/`catch` after the registry handle is
  wired, register both commands, stash the unregister fns in module scope,
  call them from `stop()`. Same idempotent-teardown pattern already used for
  `toolUnregister` and `sectionHandle`.
- `plugins/llm-agents/slash.ts` *(new)* — pure factory
  `makeSlashHandlers({ registry })` returning `{ listHandler, showHandler }`.
  No `ctx` imports, no I/O.
- `plugins/llm-agents/test/slash.test.ts` *(new)* — unit tests with hand-rolled
  fakes for the registry handle and `SlashCommandContext`.
- `plugins/llm-agents/CLAUDE.md` — add `slash.ts` to the module map and a
  short invariant for the topo-hint dependency.
- `plugins/llm-agents/package.json` — add `slash:registry` to
  `services.consumes`.

The `slash:registry` dependency is **topo-hint optional**: declared in
`services.consumes` so kaizen orders the slash plugin before this one, but the
`useService` call is wrapped in `try`/`catch` so a harness without
`llm-slash-commands` boots cleanly with the rest of the plugin (the dispatch
tool, registry, and prompt section) intact.

## Components

### `slash.ts` (new, pure)

```ts
import type { SlashCommandHandler } from "llm-contracts/public";
import type { RegistryHandle } from "./registry.ts";

export interface SlashHandlerDeps {
  registry: Pick<RegistryHandle, "service" | "getInternal">;
}

export function makeSlashHandlers(deps: SlashHandlerDeps): {
  listHandler: SlashCommandHandler;
  showHandler: SlashCommandHandler;
};
```

- `listHandler` ignores `cmdCtx.args`, walks `registry.service.list()`,
  sorts by `name`, looks up each via `registry.getInternal()` to read `scope`
  and `sourcePath`, prints one markdown bullet per agent. Empty registry →
  prints `No agents registered.`.
- `showHandler` reads `cmdCtx.args.trim()` as the agent name. Branches:
  - Empty → `Usage: /agents:show <name>`.
  - Unknown → `Unknown agent: <name>. Run /agents:list to see registered agents.`.
  - Known → prints the detail block (see Output format).
- Both handlers wrap their body in a `try`/`catch` and print
  `Error: <message>` rather than throwing — slash handlers should never
  bubble out as noisy errors.

### `index.ts` wiring

After the registry handle is wired and the always-on tool/section
registrations finish:

```ts
let slashOffs: Array<() => void> = [];
try {
  const slash = ctx.useService<SlashRegistryService>("slash:registry");
  const { listHandler, showHandler } = makeSlashHandlers({ registry: registryHandle });
  slashOffs.push(slash.register(
    { name: "agents:list", description: "List registered agents.", source: "plugin" },
    listHandler,
  ));
  slashOffs.push(slash.register(
    { name: "agents:show", description: "Show full detail for one agent.", usage: "<name>", source: "plugin" },
    showHandler,
  ));
} catch {
  // slash:registry absent — harness has no slash commands; skip silently.
}
```

`stop()` calls every entry in `slashOffs` (each `try`/`catch`-wrapped) and
clears the array, alongside the existing `toolUnregister` and `sectionHandle`
teardown.

### Registry capability used

The existing `RegistryHandle.service.list()` and `RegistryHandle.getInternal(name)`.
No new methods on the registry; no change to the `agents:registry` contract.
`getInternal` is already part of the handle for exactly this kind of
plugin-internal consumer (it exposes `scope` and `sourcePath`, which the
public `AgentManifest` strips).

## Output format

### `/agents:list`

Markdown bullet list, alphabetized by `name`:

```
- **`code-reviewer`** [user] — Use when the user wants a focused review of a diff or specific file.
- **`db-migrator`** [project] — Plans and applies schema migrations safely.
- **`runtime:router:main`** [runtime] — Routes between specialist agents based on the request.
```

Scope tag derivation: `sourcePath === "<runtime>"` → `[runtime]`; otherwise
the `scope` field (`user` or `project`).

Empty registry → `No agents registered.` (covers both the brief
discovery-microtask window and a genuinely empty harness).

### `/agents:show <name>`

Single markdown block:

```
**Agent**: code-reviewer
**Scope**: user
**Source**: /Users/chancock/.kaizen/agents/code-reviewer.md

**Description**: Use when the user wants a focused review of a diff or specific file.

**Tool filter**:
- Tags: read-only
- Names: read_file, list_files, grep*

**System prompt**:
\`\`\`
You are a focused code reviewer. ...
\`\`\`
```

Field rules:

- `Tool filter` absent → `Tool filter: none (agent inherits parent's tool view, plus always-on dispatch_agent / load_skill).`
- `toolFilter.tags` missing/empty → omit the `Tags:` sub-bullet (don't print
  "Tags: (none)"). Same for `Names:`.
- `Source: <runtime>` literal for programmatic agents (matches the value
  stored by `registry.ts` when `register()` is called).
- System prompt is printed verbatim inside a fenced code block. No
  truncation; the TUI is scrollable.

## Error handling

| Condition | Behavior |
|---|---|
| `slash:registry` not in harness | `useService` throws; caught at setup; commands not registered; plugin loads normally. |
| `slash.register` duplicate name on reload | Should not occur — `stop()` unregisters before reload. If it does, the thrown `DuplicateRegistrationError` surfaces loudly, matching every other reload-without-stop bug in the repo. |
| `/agents:list` with non-empty args | Args ignored; list still prints. |
| `/agents:show` empty/whitespace args | Print `Usage: /agents:show <name>`. |
| `/agents:show <unknown>` | Print `Unknown agent: <name>. Run /agents:list to see registered agents.`. |
| Registry empty | Print `No agents registered.`. |
| Handler throws unexpectedly | Caught inside the handler; prints `Error: <message>`. |

No event emissions. No driver calls. Both commands are read-only against
in-memory state.

## Testing

`plugins/llm-agents/test/slash.test.ts`, `bun:test`, no external mocks
(matches the plugin's existing test style):

- `listHandler` — empty registry → prints `No agents registered.`
- `listHandler` — multi-scope → prints alphabetized list with correct
  `[user]` / `[project]` / `[runtime]` tags.
- `showHandler` — empty args → prints usage line.
- `showHandler` — unknown name → prints unknown-agent line.
- `showHandler` — file-loaded agent → prints all fields including
  `Source: <path>` and full system prompt in a fenced block.
- `showHandler` — runtime agent without `toolFilter` → prints
  `Source: <runtime>` and the "none (inherits …)" tool-filter line.
- `showHandler` — `toolFilter` with only `tags` (no `names`) → omits the
  `Names:` sub-bullet; mirror case with only `names`.

Fakes: a hand-rolled object with `service.list()` and `getInternal()`
returning fixture `InternalAgentManifest` records; a fake
`SlashCommandContext` whose `print()` pushes into a captured array. The
factory is pure, so neither the real registry nor the slash dispatcher needs
to be instantiated.

Integration of `index.ts` wiring is covered by manual smoke
(`kaizen --harness ./harnesses/openai-compatible.json`, then `/agents:list`
and `/agents:show <name>`). A full-harness runtime test is not worth standing
up for two registrations.

## Local deploy

Standard llm-agents deploy from this plugin's CLAUDE.md:

```sh
cp -R plugins/llm-agents/. ~/.kaizen/marketplaces/official/plugins/llm-agents@0.2.1/
(cd ~/.kaizen/marketplaces/official/plugins/llm-agents@0.2.1 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

No version bump required for this addition unless we're cutting a release —
the marketplace JSON and `package.json` already pin `0.2.1`. Bump to `0.2.2`
when shipping publicly; out of scope for the design.
