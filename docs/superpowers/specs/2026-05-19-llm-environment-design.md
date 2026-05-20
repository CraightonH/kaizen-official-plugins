# Design: `llm-environment` — surface working-directory and host context to the LLM

**Status:** Draft — pending implementation plan
**Date:** 2026-05-19

## Problem

The openai-compatible harness assembles a system prompt from sections registered
by peer plugins. Today, nothing in that prompt tells the LLM where it is running.
There is no current working directory, no host platform, and no signal that the
session is inside (or outside) a git repository. Agents in this harness make
worse tool-selection decisions as a result — they cannot tell whether file
paths should be absolute or workspace-relative, cannot anchor `git` suggestions
to the actual repo, and have no platform signal for shell-command portability.

Claude Code surfaces this context as a matter of course; the parity gap is
visible the moment a user switches between the two and asks the same question
about local files.

## Goals

- Add an `Environment` block to the assembled system prompt containing the
  current working directory, the host platform/OS release, and the current git
  branch (when applicable).
- Make the block easy to disable per-session, per-prompt, and per-install
  without surgery.
- Establish a home for future locale, timezone, and language hints, so that
  adding them later is an additive change rather than a new plugin.
- Behave well under hot-reload: the section must register and unregister
  idempotently and bump the generation counter that the driver's assembly
  cache relies on.

## Non-goals

- Inferring or auto-detecting user intent from the environment (e.g.
  auto-loading a project mode).
- Watching the filesystem for cwd or branch changes. The static-then-refresh
  model — see *Refresh strategy* — is sufficient.
- Exporting a cross-plugin service. This plugin is a section contributor, not a
  service host.
- Modifying `llm-system-prompt`. That plugin's `CLAUDE.md` is explicit:
  identity stays narrow; peers register their own sections.

## Requirements

1. **Section.** Register exactly one section with id `llm-environment:env`,
   priority `30`, title `Environment`. Priority places it after identity (10)
   and before axioms / agents / skills / memory (50–180).
2. **Snapshot fields (v0.1.0).** Working directory, platform string
   (`process.platform` + OS release), git status (is-repo, branch).
3. **No shell-out.** Git detection is filesystem-only: walk up from cwd for a
   `.git` entry, read `HEAD` directly. This matches the existing
   no-subprocess posture of `identity.ts` and avoids per-assembly process
   spawns.
4. **Static snapshot.** Capture once at plugin `start()`; re-capture only on
   explicit refresh. The section's `render()` is a synchronous cache read.
5. **Kill switches.** Three layers, in increasing finality:
   - `KAIZEN_ENVIRONMENT_DISABLE=1` returns an empty render, which the prompt
     registry drops.
   - `prompt_disable llm-environment:env` (the existing per-section toggle)
     suppresses it for the session.
   - Uninstalling the plugin removes it entirely.
6. **Refresh.** A `/env-refresh` slash command re-captures the snapshot and
   bumps the section's generation. When `tools:registry` is present, also
   register an `environment_refresh` tool with the same effect — best-effort,
   never a hard dependency. Tags: `["environment", "diagnostic", "synthetic"]`.
7. **Teardown.** `stop()` (or the equivalent unregister path) drains every
   handle — section, slash, tool. Second invocation is a no-op.
8. **Render rules.**
   - Block is dropped entirely when disabled or empty (registry invariant).
   - When the cwd is not inside a git repo, the git line is omitted — no
     "Git repo: no" noise.
   - When the repo is in detached-HEAD state, the line reads `Git repo: yes`
     (branch is `undefined`).

## Conceptual architecture

```
ctx (kaizen)
  │
  ├── prompt:registry  ◀── consumed
  ├── slash:registry   ◀── consumed (best-effort)
  └── tools:registry   ◀── consumed (best-effort)

llm-environment plugin
  ├── lifecycle (only file touching ctx)
  │     captures snapshot, registers section, wires slash + tool,
  │     records teardown handles
  │
  ├── environment module (pure logic)
  │     captureEnvironment({ cwd, env? }) → { section, refresh() }
  │     synchronous git lookup; render() returns "" when disabled
  │
  ├── slash factory (pure)
  │     makeEnvSlashHandlers({ refresh }) → { refresh: SlashEntry }
  │
  └── tool factory (pure)
        makeEnvToolHandlers({ refresh }) → { refresh: ToolEntry }
```

Boundaries match the `llm-system-prompt` plugin's module-map convention:
exactly one file imports kaizen types or touches `ctx`; everything else is a
pure factory testable without a runtime. State lives in a single closure
(`environment` module). Slash and tool factories are stateless — they accept
the `refresh` callback rather than reaching into the state directly.

## Refresh strategy

The snapshot is captured once at `start()` and updated only when the user (or
the LLM, via the tool) asks. Rationale:

- A Kaizen session is a single terminal process; cwd cannot change underneath
  the harness without restart-equivalent action.
- Branch can change, but a stale branch name in the prompt for the duration of
  one turn is acceptable — and far cheaper than re-reading `.git/HEAD` on every
  assembly.
- Filesystem watchers add complexity and an additional failure mode. The
  explicit-refresh model has no async surface beyond the file read.

The generation counter is bumped on refresh; the assembly cache invalidates
correctly without any additional plumbing.

## Rendered output (illustrative)

```
## Environment

- Working directory: /Users/chancock/git/kaizen-official-plugins
- Platform: darwin (Darwin 25.4.0)
- Git repo: main
```

In a non-git directory:

```
## Environment

- Working directory: /tmp/scratch
- Platform: darwin (Darwin 25.4.0)
```

Detached HEAD:

```
- Git repo: yes
```

## Testability

Each module is independently testable with `bun:test`:

- **environment module** — hand-rolled `.git/` fixtures under `test/fixtures/`
  cover normal branch, detached HEAD, worktree-style `.git`-as-file pointer,
  malformed gitdir, and the disable env var. No `git init` required.
- **slash / tool factories** — exercised with a stub `refresh` callback to
  confirm the handlers wire through and surface the correct response shape.
- **lifecycle (index)** — uses a `makeFakeCtx()` helper mirroring
  `llm-system-prompt/test/index.test.ts`. Verifies section / slash / tool
  registration, best-effort behavior when a registry is absent, and idempotent
  teardown.

## Forward compatibility

The snapshot record is the natural home for additional context the LLM may
want later — likely candidates being `timezone` (from `Intl.DateTimeFormat`),
`locale` (from `LANG` / `LC_ALL`), and an explicit language hint. Shipping any
of these is an additive change: add the field, add the render line, leave the
disable switches and refresh plumbing unchanged.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Git detection misreads a worktree or submodule and shows the wrong branch | Walk-up logic stops at the first `.git`; worktree pointer (`.git` as a file containing `gitdir: …`) is followed once. Submodule users see the submodule's branch — acceptable and consistent with `git status` behavior. |
| Snapshot grows stale across long sessions (branch checked out elsewhere) | Documented `/env-refresh` and `environment_refresh` tool. Refresh is cheap. |
| Section noise crowds the prompt for users who don't want it | Three independent kill switches (env var, per-section disable, uninstall). |
| Filesystem read in `start()` fails on a hostile cwd | `captureEnvironment` swallows errors and marks `git.isRepo = false`. `render()` never throws. |

## Out of scope

- Locale / timezone / language fields (forward-compatible, not shipped now).
- Auto-detection of cwd or branch changes via filesystem watchers.
- Any cross-plugin service exported by `llm-environment`.
- Changes to `llm-system-prompt/identity.ts` or its module map.

## Open questions

- Exact service-lookup helper names in the current kaizen runtime (`useService`
  vs an optional variant). The implementation plan should mirror
  `plugins/llm-skills/index.ts:114-122` rather than guess from this spec.
- Whether the `Environment` heading is supplied by the registry (via the
  `title` field on the section) or rendered inline in the body. Both options
  work; the implementation plan picks one to match the convention in the
  other peer plugins.
