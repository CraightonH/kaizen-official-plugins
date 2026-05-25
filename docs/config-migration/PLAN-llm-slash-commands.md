# PLAN — llm-slash-commands config integration

## Re-audit verdict

Pass 1 marked this plugin SKIP on the basis that `process.env.HOME` is "OS-
standard, not config-migratable" and that the user/project command directories
are "convention-locked by cross-plugin contract." That conclusion does not
hold up against the repo-wide precedent.

The peer plugins `llm-agents` and `llm-skills` both expose structurally
identical user/project asset directories (`~/.kaizen/agents` + `.kaizen/agents`;
`~/.kaizen/skills` + `.kaizen/skills`) as `userDir` / `projectDir` (or
`userRoot`) fields under `config:store`. Slash command directories
(`~/.kaizen/commands`, `<cwd>/.kaizen/commands`) are the same category of
user-owned asset directory and belong in the same migration.

The Pass 1 reasoning conflated two different things:

- The **convention** (commands live in `.kaizen/commands` per the harness's
  on-disk layout) — yes, that's repo-wide convention.
- The **path** itself — the user is allowed to relocate this, just as they are
  for axioms / agents / skills / memory. Nothing in the codebase enforces the
  literal path; `file-loader.ts:34-35` just string-builds from `home` + `cwd`.

`process.env.HOME` is also not "OS-standard, not migratable" in this repo's
model. `llm-skills`'s plan explicitly drops a `HOME` row from its README
because `HOME` is now used only as a `~/` expansion helper for a configured
path, not as a plugin tunable. Same applies here.

The other Pass 1 calls hold: `input:submit` priority 100, `DRIVER_BARE_NAMES`,
the `{{args}}` substitution token, and the built-in grouping order are
invariants documented in `CLAUDE.md`. None of those move to config.

## Current state

`plugins/llm-slash-commands/index.ts`:

- Line 47: `const home = process.env.HOME ?? "/";` — direct env read, sole
  source of the user command directory base.
- Line 48: `const cwd = process.cwd();` — sole source of the project command
  directory base.
- Both flow into `loadFileCommands({ home, cwd, ... })`.

`plugins/llm-slash-commands/file-loader.ts:34-35`:

```ts
const userDir    = `${deps.home.replace(/\/$/, "")}/.kaizen/commands`;
const projectDir = `${deps.cwd.replace(/\/$/, "")}/.kaizen/commands`;
```

Hardcoded `.kaizen/commands` suffix in both branches. The user has no way to
relocate either directory.

`plugins/llm-slash-commands/package.json`:

- No `services.consumes` block at all.
- No `config:store` dependency declared.

`plugins/llm-slash-commands/README.md` "Configuration" section currently
documents only `HOME` as a tunable. Post-migration, that table goes away.

No other `process.env` reads. No per-plugin config-JSON reader. No
`fs.read` / `fs.write` permissions declared (`tier: "unscoped"`).

## Proposed knobs

Two fields, mirroring `llm-agents`:

| field        | type   | default                 | rationale |
|--------------|--------|-------------------------|-----------|
| `userDir`    | string | `"~/.kaizen/commands"`  | User-owned command directory. `~/` expansion happens in `index.ts` via a small local helper (precedent: `PLAN-llm-skills.md`). |
| `projectDir` | string | `".kaizen/commands"`    | Project-scoped command directory. Resolved relative to `ctx.cwd ?? process.cwd()` at setup time. |

No other knobs added. Specifically out of scope:

- `input:submit` priority — invariant per `CLAUDE.md` ("subscribes
  input:submit at priority 100"); changing it reorders dispatch vs. the
  driver's lower-priority subscriber and breaks the documented contract.
- `DRIVER_BARE_NAMES` (`builtins.ts:12`) — load-bearing for the `/help`
  grouping; coordinated with `llm-driver` ownership of `/clear` and `/model`.
- `{{args}}` token (`file-loader.ts:107`, `CLAUDE.md`) — explicit invariant:
  "Do not add Mustache-style helpers here."
- Completion-source rank order (`completion.ts`) — sort policy, not config.

## Defaults and schema

```ts
// plugins/llm-slash-commands/config.ts
import type { FieldSchema } from "llm-contracts/public";
import type { SlashCommandsConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: SlashCommandsConfig = Object.freeze({
  userDir: "~/.kaizen/commands",
  projectDir: ".kaizen/commands",
}) as SlashCommandsConfig;

export const CONFIG_SCHEMA: Record<keyof SlashCommandsConfig, FieldSchema> = {
  userDir: { type: "string", min: 1 },
  projectDir: { type: "string", min: 1 },
};
```

```ts
// plugins/llm-slash-commands/public.d.ts (addition; not re-exported cross-plugin)
export interface SlashCommandsConfig {
  userDir: string;
  projectDir: string;
}
```

`SlashCommandsConfig` stays plugin-private — no other plugin needs the shape.
Public re-exports already in `public.d.ts` (registry types, error classes)
are untouched.

## Implementation outline

1. **Add `plugins/llm-slash-commands/config.ts`** with `DEFAULT_CONFIG` +
   `CONFIG_SCHEMA` as above. Pure module, no I/O, no `ctx`.

2. **Add `SlashCommandsConfig`** to `public.d.ts` (plugin-private; the file
   already exists and re-exports other public types — append, don't replace).

3. **Update `plugins/llm-slash-commands/package.json`** — add
   `services.consumes` with `["config:store"]`. (Manifest currently has no
   `consumes` block; `provides: ["slash:registry"]` stays.) This is a
   topo-hint optional consume; `kaizen-config` boots before this plugin in
   the local harness.

4. **Rewire `index.ts` `setup()`** per the `llm-axioms` canonical pattern:

   ```ts
   import type { ConfigStoreService } from "llm-contracts/public";
   import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";
   import { homedir } from "node:os";

   const expandHome = (p: string): string =>
     p === "~" ? homedir() :
     p.startsWith("~/") ? `${homedir()}${p.slice(1)}` :
     p;

   let config: SlashCommandsConfig = { ...DEFAULT_CONFIG };
   const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
   if (cfgSvc) {
     try {
       cfgSvc.register<SlashCommandsConfig>({
         plugin: "llm-slash-commands",
         defaults: { ...DEFAULT_CONFIG },
         schema: CONFIG_SCHEMA,
       });
       config = cfgSvc.get<SlashCommandsConfig>("llm-slash-commands");
     } catch (e) {
       ctx.log?.(`llm-slash-commands: config:store register failed (${(e as Error).message}); using defaults`);
     }
   } else {
     ctx.log?.("llm-slash-commands: config:store unavailable; using DEFAULT_CONFIG");
   }
   ```

5. **Replace the `home` / `cwd` plumbing in `index.ts`**:

   - Delete `const home = process.env.HOME ?? "/";`
   - Delete `const cwd = process.cwd();` (still needed indirectly for
     `projectDir` resolution — see next bullet).
   - Compute the two resolved paths once at setup:
     ```ts
     const userDir    = expandHome(config.userDir);
     const projectCwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
     const projectDir = config.projectDir.startsWith("/")
       ? config.projectDir
       : `${projectCwd.replace(/\/$/, "")}/${config.projectDir.replace(/^\.\//, "")}`;
     ```
   - Pass `userDir` and `projectDir` (fully resolved strings) into
     `loadFileCommands`.

6. **Update `plugins/llm-slash-commands/file-loader.ts`**:

   - Change `FileLoaderDeps` so it takes `userDir: string` and
     `projectDir: string` directly instead of `home` and `cwd`.
   - Delete the inline `${deps.home}/.kaizen/commands` and
     `${deps.cwd}/.kaizen/commands` string-building at lines 34-35.
   - Replace the two `listMarkdown(deps, userDir, "user")` / `(...projectDir,
     "project")` calls so they use the passed-in fields.
   - No other behavior change. Project still shadows user (`allowReplace: true`
     only on the second pass); same warning paths; same handler shape.

7. **Watch — skip.** The plugin reads file commands once in `setup()` and
   never re-scans. Per INTEGRATION.md "If your plugin reads config once in
   `setup()` and never again, **skip `watch()`** — adding it is dead weight."
   A directory change requires a harness restart, same as today's `HOME`
   value.

8. **No permission changes.** `tier: "unscoped"` already covers reading the
   command directories (which are user data, not config-file I/O). No
   `fs.read`/`fs.write` entries to add or remove.

## Doc updates

1. **`README.md` — replace the "Configuration" section.** Drop the `HOME`
   row. Replace with a short pointer to `kaizen-config`'s `/config` slash
   commands and the two fields (`userDir`, `projectDir`).

2. **`README.md` — "Consumes" section.** Add a line noting `config:store`
   as a topo-hint optional consume.

3. **`CLAUDE.md` — module map.** Add a `config.ts` row mirroring the entry
   `llm-axioms` and `llm-skills` will have post-migration:

   > `config.ts       DEFAULT_CONFIG (Object.freeze) + CONFIG_SCHEMA. Pure;
   >                  no I/O, no ctx.`

4. **`CLAUDE.md` — invariants.** No change. The "input:submit at priority
   100" line stays exactly as-is; `DRIVER_BARE_NAMES` and `{{args}}`
   invariants stay.

## Tests

- `plugins/llm-slash-commands/test/integration.test.ts` builds a fake `ctx`
  and exercises `setup()`. The fake will not provide `config:store`, so the
  new `if (cfgSvc) { ... } else { ... }` branch will fall through to
  `DEFAULT_CONFIG` and existing assertions about loaded user / project files
  should hold unchanged (defaults match the literals today's code uses).
  Verify with `bun test`.

- `file-loader.test.ts` (if present — check during execution) likely passes
  fixture `home` / `cwd` paths. Update those tests to pass `userDir` /
  `projectDir` directly through the new `FileLoaderDeps` shape. The test
  fixtures themselves don't move on disk.

- If any test stubs `process.env.HOME`, swap the stub for direct
  `userDir` / `projectDir` arguments.

- No new test files required.

## Verification

- `cd plugins/llm-slash-commands && bun test` — all green.
- `kaizen plugin validate plugins/llm-slash-commands` — clean.
- Eyeball: `grep -n "process.env" plugins/llm-slash-commands/*.ts` should
  return nothing. `grep -n "\.kaizen/commands" plugins/llm-slash-commands/*.ts`
  should return only the `DEFAULT_CONFIG` strings in `config.ts`.

## Risks / open questions

- **`ctx.cwd` availability.** The setup uses `process.cwd()` today. If
  `ctx.cwd` is exposed by the runtime, prefer it for project-dir resolution
  (mirrors `PLAN-llm-skills.md`); otherwise keep `process.cwd()`. This is a
  read-once value, not a tunable — same status as `HOME` post-migration.
- **Absolute-path `projectDir`.** If a user sets `projectDir` to an absolute
  path, the resolution logic above honors it verbatim. That's deliberate
  parity with `llm-agents` semantics.
- **Backward compat.** Per INTEGRATION.md, no shims. Anyone relying on
  `~/.kaizen/commands` will see no change (it's the default); anyone relying
  on `HOME` being overridden will lose that lever and must use
  `userDir` instead.
- **Cross-plugin coordination.** `llm-session-manager`, `llm-driver`, and
  other peers register against `slash:registry` and do not care about
  command directories. No coordination needed.

## Contract proposals

None. The existing `ConfigStoreService` / `FieldSchema` surface covers both
fields. No new field types, validators, or store methods required.
