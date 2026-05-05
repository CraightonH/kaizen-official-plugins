# `llm-system-prompt` — System Prompt Assembler (Spec 14)

> **Note:** Config paths use the `~/.kaizen/<subdir>/` convention. See Spec 0 for rationale. This spec is dated 2026-05-04 and is the authoritative source for `prompt:system`. Where it conflicts with Spec 0 contracts (specifically the ad-hoc `llm:before-call` mutation pattern documented for `request.systemPrompt`), Spec 14 supersedes — see *Migration from ad-hoc mutation* below.

**Status:** draft
**Date:** 2026-05-04
**Tier:** 2 (B milestone — needed once any plugin wants to contribute capability surface to the model; tools, skills, agents, mcp-bridge all consume it)
**Depends on:** Spec 0 (foundation contracts, `llm:before-call`, `LLMRequest`)
**Consumed by:** `llm-driver`, `llm-tools-registry`, `llm-codemode-dispatch`, `llm-skills`, `llm-agents`, `llm-slash-commands`, `llm-memory`, `llm-mcp-bridge`
**Scope:** A single plugin, `llm-system-prompt`, that owns construction of the assistant's system prompt. Exposes a `prompt:system` service into which other plugins register named, prioritized sections. Owns the identity/persona section sourced from on-disk markdown. Emits a `prompt:rebuilt` event when the assembly changes. Does not implement code-mode API serialization (Spec 15) — only consumes its rendered output as one section among many.

## Goal

Replace the current "every plugin mutates `request.systemPrompt` in `llm:before-call`" pattern with a structured, ordered, observable assembly model. Specifically:

1. The assistant's system prompt is built from named sections registered by contributing plugins.
2. The assembly is **stable across turns by default** — built once at session start (or on a registry change event), cached, and re-used until invalidated. Local-LLM prefix-cache hit rates depend on this.
3. The plugin owns the **identity/persona section** itself. Users edit a markdown file; no plugin code changes required to alter persona.
4. The split between **what belongs in the system prompt** (stable, prefix-cache-friendly indexes and capability surface) and **what does not** (skill bodies, memory bodies, tool results, retrieved files) is enforced by convention and documented here.

## Non-goals

- Templating engines, conditional logic, partial overrides. Sections are strings; assembly is concatenation in priority order.
- Per-turn dynamic content. Anything that needs to change per-turn belongs in the user-message stream, not the system prompt. (See *Index-vs-body discipline*.)
- Owning the code-mode API surface. That is `llm-codemode-dispatch`'s contribution and the inner serialization is Spec 15.
- Token budgeting / truncation. v0 emits whatever sections produce. If a user pushes the model over context, the user is notified by the driver's existing token-warning machinery (Spec 0 § *Token accounting*).
- Encryption, redaction, or content filtering of registered sections. Plugins are trusted to render appropriate content for the model.

## Architectural overview

The plugin runs at startup, scans the global and project identity files, registers its own `identity` section with the highest priority, exposes `prompt:system` to peers, and listens for registry mutations.

- **Service path:** `prompt:system` is a registry. Peers call `register({ id, priority, render })` at their own startup and receive a handle (`RegisteredSection`) scoped to that registration. The handle is the *only* way to mutate or remove the section — there is no global `unregister(id)` or `bumpGeneration(id)`. A plugin cannot touch a section it does not own.
- **Assembly path:** the driver (the sole consumer that actually emits to the LLM) calls `prompt:system.assemble()` to get the final concatenated string. Result is memoized; cache is keyed on registry generation number.
- **Invalidation path:** any `register` / handle-`unregister` / handle-`bumpGeneration` call increments the generation number and fires `prompt:rebuilt`. The driver subscribes and drops its cached snapshot.
- **Ownership:** registering an id already owned by a different caller is rejected with a thrown error — sections cannot be stolen, overwritten, or unregistered by anyone but their original registrant.
- **Identity path:** at startup the plugin reads `~/.kaizen/system-prompt.md` (global) and `<project>/.kaizen/system-prompt.md` (project) and registers an `identity` section. Files are read once at startup and on `prompt:reload` (a slash command, see *Operational surfaces*) — not file-watched.

The plugin is read-only with respect to the filesystem, executes nothing, has no MCP surface. Permission tier is `trusted`.

## Service contract

```ts
export interface SystemPromptSection {
  /**
   * Unique identifier across the registry. Convention: `<plugin-name>:<purpose>`,
   * e.g., "llm-skills:index", "llm-memory:index", "llm-codemode-dispatch:api".
   * The reserved id `identity` belongs to llm-system-prompt itself.
   */
  id: string;

  /**
   * Sort key. Lower numbers render first. See *Section ordering* for the
   * canonical priority bands. Priority MAY be a non-integer; ordering is
   * stable for ties (registration order breaks ties).
   */
  priority: number;

  /**
   * Produces the section body. Called during assemble(). Must be cheap —
   * if a section needs expensive computation, cache internally and call
   * call handle.bumpGeneration() when the cached value changes. Returning empty
   * string omits the section entirely (no header, no separator).
   */
  render(): string | Promise<string>;

  /**
   * Optional human-readable title rendered as `## {title}` above the body.
   * If absent, the body is emitted with no header. Used for the per-section
   * indexes (skills, agents, etc.) to give the model a stable anchor.
   */
  title?: string;
}

export interface RegisteredSection {
  /** Unregister this section. No-op if already unregistered. */
  unregister(): void;
  /**
   * Signal that the section's render() output has changed. Increments
   * generation, fires prompt:rebuilt. Scoped to this handle — a plugin
   * can only bump its own sections.
   */
  bumpGeneration(): void;
}

export interface SystemPromptService {
  /**
   * Register a section. Returns a handle scoped to this registration.
   * Re-registering with the same id from the same caller is idempotent
   * (replaces the prior render fn). Re-registering an id owned by a
   * different caller is rejected with an error — sections cannot be
   * "stolen" or overwritten by other plugins.
   */
  register(section: SystemPromptSection): RegisteredSection;

  /**
   * Assembles all registered sections in priority order. Memoized on the
   * registry generation number; subsequent calls with the same generation
   * return the same string instance (driver-side identity comparisons are
   * therefore cheap).
   */
  assemble(): Promise<string>;

  /** Read-only snapshot for diagnostics / the /prompt:show slash command. */
  list(): ReadonlyArray<{ id: string; priority: number; title?: string }>;

  /** Current generation number. Increments on any registry change. */
  generation(): number;
}
```

### Events

Registered with `ctx.defineEvent` at plugin start and added to the `VOCAB` constant exported by `llm-events` (Spec 0 § *Event vocabulary*):

| Event | Payload | Notes |
|---|---|---|
| `prompt:rebuilt` | `{ generation: number }` | Fired after any `register`, handle-`unregister`, or handle-`bumpGeneration` call. The driver MUST drop its cached assembly upon receipt. |
| `prompt:reload` | `{}` | Fired by the `prompt:reload` slash command (see *Operational surfaces*). The plugin re-reads identity files from disk and bumps the `identity` section's generation. |

### Section ordering

Priority bands are advisory but enforced by code review. The driver does not validate priority values; lower number = earlier in the prompt.

| Band | Range | Owner | Purpose |
|---|---|---|---|
| Identity | `0–99` | `llm-system-prompt` | Persona, base framing, current date, hard rules |
| Capability surface | `100–199` | `llm-codemode-dispatch` (or `llm-native-dispatch`) | Code-mode `.d.ts` API surface OR native tool-call instructions — exactly one strategy contributes |
| Capability indexes | `200–399` | `llm-skills`, `llm-agents`, `llm-slash-commands`, `llm-mcp-bridge` (resources only) | One-line-per-item indexes with descriptions and when-to-use |
| Persistent context | `400–499` | `llm-memory` | Memory index (filenames + descriptions) — never bodies |
| Tail | `900–999` | reserved for project-specific hooks | Last-word framing, output format reminders |

Ranges are gapped intentionally so users / future plugins can wedge in without colliding. Sections within a band sort by priority then registration order.

## Identity section

`llm-system-prompt` registers exactly one section, `identity`, at priority `10`.

### Sourcing

Lookup order (each layer is optional; missing files contribute nothing):

1. `<project>/.kaizen/system-prompt.md` — project override. `<project>` is `ctx.cwd` at plugin start.
2. `~/.kaizen/system-prompt.md` — global default.

### Merge rule

If only one file exists, its contents become the `identity` section verbatim. If both exist, the rendered section is:

```
{global-contents}

## Project context

{project-contents}
```

That is: the global file frames the assistant's persona once; the project file appends repo-specific framing under a fixed header. Concat (not replace) is the chosen rule because it lets users keep their persona stable across projects while adding per-repo context. If a user genuinely wants to replace the global, they delete the global file or override with `KAIZEN_SYSTEM_PROMPT_GLOBAL=` (empty).

### Hard fallback

If neither file exists, the section renders a baked-in default:

```
You are a helpful assistant running locally via the kaizen openai-compatible
harness. Today is {YYYY-MM-DD}. The user prefers concise answers and
direct action; avoid unnecessary preamble. When tools are available, prefer
calling them over guessing. When skills are listed below, load them on
demand rather than guessing their contents.
```

The date is interpolated at assembly time, not at startup, because a long-running session can cross midnight. Date interpolation invalidates the assembly at most once per day — driver-side cache compares the rendered string, not the generation alone, so an unchanged identity does not actually re-emit a `prompt:rebuilt` event for the date roll. (Implementation: identity render() returns a string whose date suffix is computed at call time; bump only happens on file change or `prompt:reload`.)

### Environment variable overrides

| Var | Effect |
|---|---|
| `KAIZEN_SYSTEM_PROMPT_GLOBAL` | Overrides path to `~/.kaizen/system-prompt.md`. Set to empty string to disable the global layer entirely. |
| `KAIZEN_SYSTEM_PROMPT_PROJECT` | Overrides path to `<project>/.kaizen/system-prompt.md`. |
| `KAIZEN_SYSTEM_PROMPT_DISABLE` | If `1`, the identity section renders empty; only contributor sections appear. Used by the `llm-driver` test harness. |

## Index-vs-body discipline

This is the load-bearing rule that makes the prefix-cache strategy work.

**Belongs in the system prompt (registered as a section):**

- The assistant's identity / persona / current date.
- The complete tool capability surface (code-mode `.d.ts` or native schemas). Required for the model to know what it can call.
- A one-line-per-item **index** of skills, agents, slash commands, memory entries — name + description + (optional) when-to-use trigger.
- MCP **resource catalog** entries (URI + description). Resource bodies do NOT go here.

**Does NOT belong in the system prompt:**

- Skill bodies. They land in the user-message stream as a tool result when `load_skill` is invoked (Spec 7).
- Memory entry bodies. They land in the user-message stream when `memory_recall` is invoked, or are pre-injected as a *user* message by the memory plugin if eager-loading is on (Spec 9).
- Tool execution output / errors / stdout. Always a tool-result message in the conversation transcript.
- MCP resource contents. Fetched on demand and injected as a user message.
- The current user turn, recent turn history, retrieved files, RAG hits.
- Ephemeral state like "the current branch is X" or "the user just clicked Y" — those belong in the next user message, not the system prompt.

**Why:** the system prompt is the prefix the local model caches. Anything that mutates per-turn destroys that cache. The single exception is the date in the identity fallback, and that mutates at most once per day.

**Enforcement:** convention. There is no runtime check that a section's render() output is "stable enough." Code review and the `prompt:rebuilt` event firing rate (observable via `/prompt:show --stats`) are the feedback loops.

## Driver integration

The driver's existing `llm:before-call` flow changes as follows.

### Before (Spec 0 baseline)

```ts
// In driver, per turn:
const request: LLMRequest = { systemPrompt: "", messages, tools, ... };
await emit("llm:before-call", { request });   // subscribers mutate request.systemPrompt
const stream = llmComplete.complete(request, { signal });
```

### After

```ts
// At driver startup:
let cachedSystemPrompt: string | null = null;
let cachedGeneration = -1;
on("prompt:rebuilt", () => { cachedSystemPrompt = null; });

// Per turn:
if (cachedSystemPrompt === null || promptSystem.generation() !== cachedGeneration) {
  cachedSystemPrompt = await promptSystem.assemble();
  cachedGeneration = promptSystem.generation();
}
const request: LLMRequest = {
  systemPrompt: cachedSystemPrompt,
  messages,
  tools,
  ...,
};
await emit("llm:before-call", { request });   // subscribers MAY still mutate, but SHOULD NOT
const stream = llmComplete.complete(request, { signal });
```

`llm:before-call` is preserved as an escape hatch (model overrides, request cancellation, last-resort augmentation) but contributing system-prompt content via mutation is deprecated.

### Cache key

The driver caches by `generation` number. It does NOT recompute on every turn even if generation is unchanged — that is the entire point of the cache. A session that never sees a `prompt:rebuilt` event holds the same `cachedSystemPrompt` string instance for its lifetime, and providers that respect prefix caching (LM Studio, Ollama, vLLM with `--enable-prefix-caching`) get clean hits.

### Cache miss budget

Realistic mid-session events that DO bust the cache:

| Event | Trigger | Frequency |
|---|---|---|
| `mcp:reload` | User runs the slash command after editing `~/.kaizen/mcp/servers.json` | Rare (manual) |
| Skill / agent file added | `prompt:reload` slash command | Rare (manual) |
| `/model` switch | User changes model | Rare |
| Memory write | `memory_save` tool or `/remember` slash command | Possible per-session, but only the index changes — body never goes to system prompt |
| Identity file edit | `prompt:reload` | Manual |

A typical session sees zero rebuilds. A heavy session sees one or two. This is acceptable.

## Operational surfaces

### Slash commands

Registered into `slash:registry` (Spec 8). All are namespaced under `prompt:` per the bare-name reservation rule.

| Command | Effect |
|---|---|
| `/prompt:show` | Prints the current assembled system prompt to the TUI output area, with section headers annotated (`### [identity, p=10]` etc.) so the user can see what the model sees. |
| `/prompt:show --stats` | Adds per-section length in characters and the cumulative `prompt:rebuilt` count for the session. |
| `/prompt:reload` | Re-reads identity files from disk, bumps generation, fires `prompt:rebuilt`. |
| `/prompt:disable <id>` / `/prompt:enable <id>` | Diagnostic toggle. Disabled sections render empty without leaving the registry. State is per-session; resets at restart. |

### Telemetry events (informational)

Emitted on the existing event bus; no new vocabulary needed:

- `prompt:rebuilt` — already specified. Subscribers get the new generation number.

## Migration from ad-hoc mutation

`llm-skills` (Spec 7), `llm-memory` (Spec 9), and others currently document subscribing to `llm:before-call` and mutating `request.systemPrompt` in place. Those plugins must migrate as follows:

1. At plugin startup, register a section with `prompt:system.register({ id, priority, render })`.
2. Replace the `llm:before-call` subscriber's body with a call to `handle.bumpGeneration()` (where `handle` is the `RegisteredSection` returned by `register()`) *only if* the plugin's data has changed since the last assembly. (For most plugins, the data only changes via discrete events — `skill:loaded`, `memory:saved` — and the `bumpGeneration` call belongs in those handlers, not in `llm:before-call` at all.)
3. Remove the `llm:before-call` subscriber once step 2 is in place.

`llm:before-call` remains the contract for non-system-prompt mutations (model swap, header injection at the HTTP layer via `extra`, `cancelled` short-circuit). It is no longer the canonical channel for system-prompt content.

## File layout

```
plugins/llm-system-prompt/
  plugin.json
  src/
    index.ts            # plugin entry, registers service + identity section
    registry.ts         # SystemPromptService implementation
    identity.ts         # global+project file resolution, fallback, date interpolation
    slash.ts            # /prompt:show, /prompt:reload, /prompt:disable, /prompt:enable
  public.d.ts           # SystemPromptService, SystemPromptSection types
  README.md
```

## Open questions

- **Should `llm-codemode-dispatch`'s `systemPromptAppend` (Spec 0 § `tool-dispatch:strategy`) flow through `prompt:system` or stay as a strategy-level addition?** Tentative answer: the strategy registers a `llm-codemode-dispatch:api` section at priority 100 and stops returning `systemPromptAppend` from `prepareRequest`. That keeps assembly in one place and lets `/prompt:show` reflect the full prompt. Spec 15 finalizes.
- **Should there be a per-section dry-run cap on render() time?** Probably yes (1s warn, 5s error) but defer to v1.
- **Should `assemble()` return a structured representation in addition to the flat string?** Useful for telemetry but not for the LLM. v1 if needed.

## Acceptance criteria

1. A user can edit `~/.kaizen/system-prompt.md`, run `/prompt:reload`, and see the new persona reflected on the next turn without restarting the harness.
2. A test harness can register N sections, assemble, and confirm output is concatenation in priority order.
3. The driver caches the assembly across turns; `prompt:rebuilt` is the only event that drops the cache.
4. With `KAIZEN_SYSTEM_PROMPT_DISABLE=1`, the assembled prompt contains zero identity content but still contains contributor sections.
5. `/prompt:show` renders the current prompt with section headers visible to the user.
6. `llm-skills`, `llm-memory`, etc. no longer mutate `request.systemPrompt` in `llm:before-call` — verified by grep against the plugin sources after migration.
