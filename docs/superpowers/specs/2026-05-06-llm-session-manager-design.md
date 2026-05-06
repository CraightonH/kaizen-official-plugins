# `llm-session-manager` — Session Persistence and Sub-Agent Sessions

**Status:** draft
**Date:** 2026-05-06
**Tier:** 2 (cross-cutting; touches driver, agents, events, tools-registry contracts)
**Depends on:** Spec 0 (foundation contracts), kaizen `ctx.harness` (HarnessIdentity)
**Consumed by:** `llm-driver`, `llm-agents`, `llm-slash-commands`, future meta-harness analysis tooling
**Breaks:** event vocab `session:*` (REPL lifecycle) → `harness:*`; `llm-driver` `state.messages` ownership; `dispatch_agent` schema; `ToolExecutionContext` shape

## Goal

Move conversation persistence out of `llm-driver` into a dedicated plugin that:

1. **Persists sessions to disk**, namespaced by harness, so sessions survive restarts.
2. **Holds multiple sessions concurrently** in-memory so the driver can drive any one as the active session and sub-agents can carry their own histories across multiple dispatches.
3. **Captures a full execution trace** (LLM payloads, tool calls, errors, timings) per session, suitable for [meta-harness](https://yoonholee.com/meta-harness/) analysis — uncompressed, append-only, filesystem-resident.
4. **Decouples** the driver from message storage so any session-manager implementation honoring the contract can drop in.

The hero use case is **decomposition → fan-out**: the main interactive session breaks a problem down and dispatches sub-tasks to sub-agents, each with its own persistent history, addressable by a caller-supplied id.

## Non-goals

- **Parallel `dispatch_agent` execution.** Unblocked architecturally by this spec but implemented separately (see *Parallel dispatch readiness*).
- **Per-token streaming events in the log.** The final `llm:response` carries full content. A future `llm:chunk` event can be added without changing this spec's storage layout.
- **Redaction / secret scrubbing.** Sessions live under `~/.kaizen/`. Local user, local files. If redaction becomes a concern, the manager exposes a hook later — not designed in v0.
- **Retention / TTL of ephemeral sub-sessions.** All dispatches persist in v0. Pruning policy is v1.
- **Cross-harness migration.** Sessions are partitioned by harness. Resuming under a different harness is unsupported and not validated.
- **Token budgeting / truncation.** Out of scope; lives elsewhere.
- **A session-record query DSL.** `list()` and `readEvents()` are the only read APIs. Meta-harness analysis is filesystem-walking, not query-driven.

## Architectural overview

```
                                 ctx.harness (kaizen)
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────┐
│                         llm-session-manager                           │
│  ~/.kaizen/sessions/<harness-key>/                                    │
│    ├── index.jsonl                                                    │
│    └── <session-id>/{snapshot.json, events.jsonl}                     │
│                                                                       │
│  service: sessions:store                                              │
│  subscribes: turn:*, llm:*, tool:*, prompt:rebuilt                    │
│  emits: session:created, session:resumed, session:deleted,            │
│         session:active-changed (forwarded from driver)                │
└───────────────────────────────────────────────────────────────────────┘
            ▲                                                ▲
            │ create/load/getMessages/beginTurn              │ writes events
            │                                                │
┌───────────────────────────┐               ┌────────────────┴──────────┐
│        llm-driver         │               │    (event bus / others)   │
│  state.activeSessionId    │               └───────────────────────────┘
│  no state.messages        │
│  emits harness:* (REPL)   │
│  emits session:active-    │
│    changed when flipped   │
└───────────┬───────────────┘
            │ runConversation({ sessionId, turnHandle })
            ▼
┌───────────────────────────┐
│        llm-agents         │
│  dispatch_agent gains     │
│  optional session_id      │
│  reads ctx.sessionId      │
└───────────────────────────┘
```

**Boundaries:**

- **Driver** is stateless re: messages. It holds `activeSessionId` only. All message reads/writes go through `sessions:store`. The driver no longer owns the `preTurnSnapshot` rollback machinery — that becomes `TurnHandle.commit()` / `TurnHandle.rollback()`.
- **Manager** is the only writer of `~/.kaizen/sessions/`. It provides `sessions:store`. It subscribes to lifecycle events (`turn:start`, `turn:end`, `llm:request`, `llm:response`, `tool:call`, `tool:result`, `tool:error`, `turn:cancel`, `turn:error`, `prompt:rebuilt`) and writes each event to the active session's `events.jsonl`. The driver does not call any "log this" API.
- **Agents** changes only in `dispatch.ts`: passes `session_id` through and resolves the parent session via `ctx.sessionId`.
- **No new event vocab from the manager** beyond the four `session:*` lifecycle events listed below. The driver stops emitting `session:start`/`session:end` (semantic clash) and emits `harness:start`/`harness:end` instead.

## Decisions and rationale

| # | Decision | Rationale |
|---|---|---|
| D1 | Sub-agent session policy: **caller-supplied `session_id`** on `dispatch_agent` | Lets the dispatching LLM choose between fanning out (parallel sessions, distinct ids) and continuing (same id). Composes recursively — orchestrator-of-orchestrators works without special casing. |
| D2 | Persistence model: **append-only `events.jsonl` + per-turn snapshot rewrite** | Snapshot is the conversation (what the LLM needs to resume); event log is the execution trace (what meta-harness analysis needs). Both required, neither sufficient alone. |
| D3 | Session identity: **UUID for top-level + caller-supplied child id (`<parent>/<child>`) for sub-sessions** | LLMs are bad at UUIDs and good at short labels. Namespacing under parent prevents collisions across unrelated orchestrators. |
| D4 | Sub-session structural treatment: **identical to top-level, listing filters by default** | Preserves recursive orchestration. The "ephemeral worker" mental model is a UX default, not a data-model constraint. |
| D5 | Manager owns canonical messages; driver becomes stateless | Smallest, most replaceable contract. Driver depends only on `sessions:store`. Any drop-in implementation works. |
| D6 | Driver tracks `activeSessionId` itself | "Active" is a driver/UX concept, not a session-store concept. A different harness might drive multiple sessions in parallel and have no single "active." |
| D7 | System prompt: **always re-resolved fresh per turn** | Matches existing driver behavior. Editing skills/agents/manifest between turns surfaces in the next turn. Reproducibility of any specific past call is preserved by the event log capturing the actual prompt sent. |
| D8 | Storage namespaced by harness key derived from `ctx.harness` | Prevents cross-harness session contamination. Plugin-set is harness-bound; sessions must be too. |
| D9 | Vocab rename: `session:*` → `harness:*` for REPL lifecycle; new `session:*` for record lifecycle | The previous events meant "interactive program is starting/ending." With sessions now first-class, that's misleading. `harness:*` matches kaizen's nomenclature. |

## Service contract: `sessions:store`

```ts
import type { ChatMessage } from "llm-events/public";

export interface SessionRecord {
  id: string;                       // UUID for top-level; "<parent>/<child>" for sub-sessions
  harness: string;                  // pinned at create from harnessKey(ctx.harness)
  parentSessionId?: string;
  alias?: string;                   // optional human label, unique under same parent
  agentName?: string;               // set when created via dispatch_agent
  model?: string;                   // optional override; otherwise provider default
  metadata: Record<string, unknown>;
  createdAt: number;
  lastTurnAt?: number;
  pluginFingerprint: string[];      // sorted "<name>@<version>" at creation
}

export interface TurnHandle {
  readonly turnId: string;
  /** Sync, in-memory buffered append. Multiple appends per turn are normal. */
  append(msg: ChatMessage): void;
  /** Persists snapshot + finalizes events.jsonl flush. Throws on disk error. */
  commit(): Promise<void>;
  /** Discards buffered appends. Idempotent; safe to call after commit (no-op). */
  rollback(): Promise<void>;
}

export interface SessionsStoreService {
  /**
   * Create a new session.
   *  - Top-level: omit parentSessionId; manager generates UUID id.
   *  - Sub-session: pass parentSessionId AND childId. id becomes "<parent>/<child>".
   * Throws on alias collision (within same parent), invalid childId, or missing parent.
   */
  create(opts: {
    parentSessionId?: string;
    childId?: string;                              // required iff parentSessionId set
    alias?: string;
    agentName?: string;
    model?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionRecord>;

  /** Throws if id missing. Returns the record (without the messages array). */
  load(id: string): Promise<SessionRecord>;

  exists(id: string): Promise<boolean>;

  /** Canonical ChatMessage[] for the next LLM call. Manager caches active sessions in memory. */
  getMessages(id: string): Promise<ChatMessage[]>;

  /**
   * Open a turn. turnId is supplied by the driver (already minted via newTurnId()).
   * Throws if the session already has an open turn (single-writer per session).
   */
  beginTurn(id: string, turnId: string): TurnHandle;

  list(opts?: {
    parentSessionId?: string | null;               // null/undefined = top-level only (default)
    includeChildren?: boolean;                      // override the default filter
    limit?: number;
  }): Promise<SessionRecord[]>;

  /** cascade: also delete sub-sessions. Default false; throws if children exist. */
  delete(id: string, opts?: { cascade?: boolean }): Promise<void>;

  /**
   * Streaming read of the event log. Each entry is one JSONL line.
   * Async iterable so meta-harness consumers can scan multi-MB logs without
   * loading them into memory.
   */
  readEvents(
    id: string,
    opts?: { fromOffset?: number; limit?: number },
  ): AsyncIterable<EventLogEntry>;
}

export interface EventLogEntry {
  offset: number;     // monotonic per session
  ts: number;
  turnId?: string;    // present for turn-scoped events
  event: string;      // e.g. "llm:request"
  payload: unknown;
}
```

**Contract notes:**

- **`turnId` is driver-owned.** The driver mints turn ids (`newTurnId()` in `llm-driver/ids.ts`) and passes them in. The manager does not generate turn ids — they're already part of `turn:start`/`turn:end` event payloads, so this keeps event-log entries joinable on `turnId` without a separate manager-side mapping.
- **Single-writer per session.** `beginTurn()` throws if the same session already has an open turn handle. Prevents interleaved appends from concurrent code paths. (Different sessions can have open turns concurrently — that's the whole point of the design.)
- **All writes go through a turn handle.** No `appendMessage(id, msg)` outside of a turn. The handle is the rollback boundary, replacing the driver's current `preTurnSnapshot` machinery.
- **Errors throw.** Duplicate alias under same parent → throws. Invalid `childId` (regex `^[A-Za-z0-9_.-]+$`) → throws. `load` of missing id → throws. Manager is the policy enforcer.
- **`SessionRecord` does not include `messages`.** Use `getMessages()`. Keeps `load()` cheap.

## Lifecycle events

Defined in `llm-events/public` (this spec changes the events vocab — see *Vocab rename* below).

| Event | Emitter | Payload |
|---|---|---|
| `harness:start` | driver | `{}` |
| `harness:end` | driver | `{}` |
| `harness:exit-requested` | driver / `/exit` | `{}` |
| `harness:error` | driver | `{ message, cause }` |
| `session:created` | manager | `{ id, harness, parentSessionId?, alias?, agentName? }` |
| `session:resumed` | driver (via slash command) | `{ id }` |
| `session:deleted` | manager | `{ id, cascade }` |
| `session:active-changed` | driver | `{ from: string \| null, to: string }` |

**Removed events (from `llm-events`):** `session:start`, `session:end`, `session:exit-requested`, `session:error`. Same semantic moves to `harness:*`. Subscribers in `llm-status-items`, `llm-events`, and any other plugin update in lockstep.

## On-disk layout

```
~/.kaizen/sessions/<harness-key>/
├── index.jsonl                     # one line per session record op (create/update/delete)
└── <session-id>/
    ├── snapshot.json               # rewritten atomically on TurnHandle.commit()
    └── events.jsonl                # append-only, fsync on commit, NEVER compacted
```

For sub-sessions, `<session-id>` is the literal `<parent>/<child>`, so directories nest:

```
~/.kaizen/sessions/official_openai-compatible/
├── 7f3e<...uuid...>/
│   ├── snapshot.json
│   └── events.jsonl
└── 7f3e<...uuid...>/reviewer-fileA/
    ├── snapshot.json
    └── events.jsonl
```

**snapshot.json** (single JSON object, rewritten on `TurnHandle.commit()`):

```json
{
  "schemaVersion": 1,
  "id": "7f3e.../reviewer-fileA",
  "harness": "official_openai-compatible",
  "parentSessionId": "7f3e...",
  "alias": null,
  "agentName": "code-reviewer",
  "model": null,
  "metadata": {},
  "createdAt": 1715000000000,
  "lastTurnAt": 1715000123456,
  "pluginFingerprint": ["llm-driver@0.1.0", "llm-agents@0.1.0", "..."],
  "messages": [ /* ChatMessage[] */ ]
}
```

**events.jsonl** (one JSON object per line, appended as events arrive):

```jsonl
{"offset":0,"ts":1715000000000,"turnId":"t-abc","event":"turn:start","payload":{...}}
{"offset":1,"ts":1715000000050,"turnId":"t-abc","event":"llm:request","payload":{"model":"...","messages":[...],"tools":[...],"systemPromptText":"..."}}
{"offset":2,"ts":1715000001234,"turnId":"t-abc","event":"llm:response","payload":{"content":"...","tool_calls":[...],"finish_reason":"tool_calls","usage":{...},"latencyMs":1184}}
{"offset":3,"ts":1715000001245,"turnId":"t-abc","event":"tool:call","payload":{"toolName":"read_file","args":{...},"callId":"c-1"}}
```

`offset` is monotonic per session, used by `readEvents({ fromOffset })`. Writes use `O_APPEND`. On `TurnHandle.commit()`, both `events.jsonl` (any in-memory-buffered tail) and `snapshot.json` are flushed/fsynced.

**index.jsonl** (one append per session create / lastTurnAt update / delete):

```jsonl
{"op":"create","id":"7f3e...","alias":"refactor-spike","parentSessionId":null,"createdAt":1715000000000}
{"op":"update","id":"7f3e...","lastTurnAt":1715000123456}
{"op":"delete","id":"7f3e...","cascade":true}
```

Index is a **derived view**. On startup the manager reads it to populate an in-memory map. If corrupt or missing, manager rebuilds by walking `<harness-key>/*/snapshot.json`. Self-healing.

**Crash safety:**

- Snapshot writes use temp-file + atomic rename (`snapshot.json.tmp` → `snapshot.json`). Half-written snapshots are impossible.
- `events.jsonl` is append-only with fsync. On startup, manager scans tail of each open `events.jsonl`; partial trailing line (no `\n`) is detected and truncated.
- Index entries lag snapshot/events writes by definition — recovery walks dirs if the index is stale or missing.

## Event log: which events, what fields

Manager subscribes in `setup()` to the following from the existing `llm-events` vocab. Each event is written as one JSONL line to `events.jsonl` of the session that owns the turn (resolved via `turnId` → session lookup table the manager maintains, populated on `turn:start` and cleared on `turn:end`).

| Event | Notable payload fields |
|---|---|
| `turn:start` | `turnId`, `parentTurnId?`, `trigger` (user/agent), `sessionId`, `agentName?` |
| `turn:end` | `turnId`, `reason` (complete/cancelled/error), `durationMs` |
| `turn:error` | `turnId`, `message`, stringified `cause` |
| `turn:cancel` | `turnId` |
| `llm:request` | `turnId`, `model`, `messages`, `tools`, `temperature?`, all params, `systemPromptText` (the actual string sent) |
| `llm:before-call` | `turnId`, mutation snapshot (only logged when a subscriber mutated the request) |
| `llm:response` | `turnId`, `content`, `tool_calls?`, `finish_reason`, `usage`, `latencyMs` |
| `llm:error` | `turnId`, `message`, `status?`, `cause` |
| `tool:call` | `turnId`, `toolName`, `args`, `callId` |
| `tool:result` | `turnId`, `callId`, `toolName`, `result`, `durationMs` |
| `tool:error` | `turnId`, `callId`, `toolName`, `message`, `cause` |
| `prompt:rebuilt` | `generation`, `sources` |

**Not separately logged** (already captured upstream):

- Per-token streaming chunks. Final `llm:response` carries the full content.
- `harness:*` events. Global, written elsewhere if at all.
- `conversation:user-message` / `conversation:assistant-message` / `conversation:system-message`. Derivable from `messages` in the snapshot + `llm:request` / `llm:response` in the event log.

**Failure modes:**

- **Event-log write throws:** manager logs and *drops* the event. Does not crash the turn. Better to miss a log line than to fail a real conversation because disk is full.
- **Snapshot write throws on `commit()`:** rejects, driver gets the error, treats as turn-error, the on-disk session reflects the *previous* committed state.

## Driver changes (`llm-driver`)

State shape:

```ts
const state: {
  currentTurn: CurrentTurn | null;
  activeSessionId: string | null;     // replaces `messages`
  systemPrompt: string;                // unchanged; resolved fresh each turn
} = { currentTurn: null, activeSessionId: null, systemPrompt: "" };
```

**`setup()`:**

- Consume `sessions:store` (required, not optional).
- Subscribe to `session:active-changed` to update `state.activeSessionId` (slash commands emit this when the user runs `/session:resume`).
- `conversation:cleared` (or whatever `/clear` emits) calls `sessions.create({})`, sets `activeSessionId` to the new id, emits `session:active-changed`. **Old session is kept on disk** (archived, listable via `/session:list`) — not deleted. Explicit deletion is `/session:delete`.

**`start()` interactive loop** (sketch):

```ts
emit harness:start
if (!state.activeSessionId) {
  const sess = await sessions.create({});
  state.activeSessionId = sess.id;
  emit session:active-changed { from: null, to: sess.id }
}

loop:
  line = await ui.readInput()
  if (line === "") break

  inputHandled = false
  emit input:submit { text: line }
  if (exitRequested) break
  if (inputHandled) continue

  const turnId = newTurnId()
  const handle = sessions.beginTurn(state.activeSessionId, turnId)
  handle.append({ role: "user", content: line })
  ui.writeUser?.(line)
  emit conversation:user-message { message: { role: "user", content: line } }

  const systemPrompt = await prompt:system.assemble()    // unchanged
  state.currentTurn = { id: turnId, controller: new AbortController() }
  emit turn:start { turnId, sessionId: state.activeSessionId, trigger: "user" }

  try {
    const result = await runConversation({
      systemPrompt,
      sessionId: state.activeSessionId,
      turnHandle: handle,
      signal: state.currentTurn.controller.signal,
      externalTurnId: turnId,
      trigger: "user",
    }, deps)
    await handle.commit()
    // ... assistant output, duration notice, conversation:assistant-message ...
    emit turn:end { turnId, reason: "complete", durationMs: ... }
  } catch (abort) {
    await handle.rollback()
    emit turn:end { turnId, reason: "cancelled" }
  } catch (err) {
    await handle.rollback()
    emit turn:error { turnId, message, cause }
    emit turn:end { turnId, reason: "error" }
  } finally {
    state.currentTurn = null
  }

emit harness:end
```

**`runConversation` (loop.ts) signature change:**

- Remove: `messages: ChatMessage[]`
- Add: `sessionId: string`, `turnHandle: TurnHandle`
- Inside the loop, before each LLM call: `const messages = await deps.sessions.getMessages(sessionId)`.
- Each new message (assistant content, assistant `tool_calls`, tool results) is appended via `turnHandle.append()`.
- Drop `RunConversationOutput.messages`. Keep `finalMessage` for ergonomics.

The agent path (called from `dispatch.ts`) does not pass `turnHandle` — it passes `userMessage` and the loop opens its own turn handle internally (see *Agent dispatch changes*).

## Agent dispatch changes (`llm-agents`)

**Tool schema** (`dispatch.ts`):

```ts
export const DISPATCH_SCHEMA: ToolSchema = {
  name: "dispatch_agent",
  description:
    "Delegate a sub-task to a named specialist agent. Returns the agent's final response. " +
    "Use `session_id` to continue an existing sub-agent thread or start a fresh one.",
  parameters: {
    type: "object",
    required: ["agent_name", "prompt"],
    properties: {
      agent_name: { type: "string", description: "..." },
      prompt: { type: "string", description: "..." },
      session_id: {
        type: "string",
        description:
          "Optional. Short label identifying a sub-agent thread under the current session. " +
          "Reusing the same session_id continues the same sub-agent's history; a new session_id " +
          "starts a fresh thread. Omitted = one-shot (fresh, ephemeral).",
      },
    },
    additionalProperties: false,
  },
  tags: ["agents", "core"],
};
```

**Handler:**

```ts
const parentSessionId = ctx.sessionId;
if (!parentSessionId) throw new Error("dispatch_agent: ToolExecutionContext.sessionId missing");

const childId = args.session_id ?? `oneshot-${shortUuid()}`;
const fullId = `${parentSessionId}/${childId}`;

let session;
if (await sessions.exists(fullId)) {
  session = await sessions.load(fullId);
  if (session.agentName !== name) {
    throw new Error(
      `session_id '${childId}' already exists under a different agent ('${session.agentName}')`
    );
  }
} else {
  session = await sessions.create({
    parentSessionId,
    childId,
    agentName: name,
    model: internal.modelOverride,
  });
}

const input: RunConversationInput = {
  systemPrompt: internal.systemPrompt,    // resolved fresh from current manifest
  sessionId: session.id,
  toolFilter,
  ...(internal.modelOverride ? { model: internal.modelOverride } : {}),
  parentTurnId: ctx.turnId,
  signal: ctx.signal,
  userMessage: { role: "user", content: args.prompt },
};

// runConversation opens its own TurnHandle when called via this path.
const output = await deps.driver.runConversation(input);
return String(output.finalMessage.content ?? "");
```

**`ToolExecutionContext` addition** (in `llm-tools-registry`):

```ts
export interface ToolExecutionContext {
  // ...existing fields...
  turnId: string;
  sessionId: string;     // NEW: required, mirrors turnId pattern
}
```

The driver populates `sessionId` when invoking tools, same as it does `turnId` today. Consumers (dispatch_agent and any future tool that wants to know its session) read it directly.

**Depth tracking is unchanged.** `turn-tracker.ts` walks `parentTurnId`. Sub-sessions don't change depth semantics — depth is about turn ancestry, not session ancestry.

## Slash commands (`llm-slash-commands`)

Per the harness's namespacing rule (`<source>:<name>`), session commands use the `session:` prefix:

| Command | Behavior |
|---|---|
| `/session:new` | Create fresh top-level session, emit `session:active-changed`. |
| `/session:list` | List top-level sessions for the current harness. `--all` includes sub-sessions. |
| `/session:resume <id\|alias>` | Resolve id, set as active, emit `session:active-changed` and `session:resumed`. Errors if id missing. |
| `/session:delete <id>` | Delete a session. Confirmation prompt. `--cascade` for sub-trees. |

`/clear` (existing command) **archives** the active session and creates a new one. The archived session remains on disk and listable; explicit deletion uses `/session:delete`.

The driver itself does not register these — `llm-slash-commands` does, calling `sessions:store` directly.

## Harness key derivation

`ctx.harness: { jsonPath?: string; ref?: string }` (kaizen exposes raw metadata; it does not derive a canonical name. See kaizen `docs/core-internals.md` and `docs/reference/plugin-api.md` for `HarnessIdentity`.). The session manager derives its namespacing key:

```ts
import { basename, dirname } from "node:path";
import type { HarnessIdentity } from "kaizen/types";

export function harnessKey(h: HarnessIdentity): string {
  // Prefer jsonPath: it's the resolved canonical artifact, and basename-based
  // derivation produces the same key whether the user invoked via marketplace
  // ref or local file path. ref-based derivation can drift between those two
  // invocation paths for the same logical harness.
  if (h.jsonPath) {
    const base = basename(h.jsonPath);
    // Two on-disk shapes:
    //   directory-style:  .../harnesses/<name>/kaizen.json
    //   single-file:      harnesses/<name>.json
    // Both yield <name> via this derivation. Marketplace-installed harnesses
    // (~/.kaizen/marketplaces/<id>/harnesses/<name>/kaizen.json) also yield <name>.
    return base === "kaizen.json"
      ? basename(dirname(h.jsonPath))
      : base.replace(/\.json$/, "");
  }
  if (h.ref) {
    // Strip @version so session resume survives version bumps within a harness.
    // Within-major plugin-set drift is graceful (missing tools simply don't appear).
    return h.ref.replace(/@.*$/, "").replace(/[^A-Za-z0-9_.-]/g, "_");
  }
  return "default";
}
```

Manager calls `harnessKey(ctx.harness)` once at `setup()` and pins the result. All session paths and listings are scoped to that key.

## Parallel dispatch readiness (Phase 2 — not in v1)

This spec architecturally unblocks parallel sub-agent dispatch but does not implement it. Concrete follow-ups (scoped to `llm-driver`):

1. **Native tool-dispatch loop runs `tool_calls` concurrently.** Replace the sequential `for (const call of tool_calls) await execute(call)` with `Promise.all(tool_calls.map(execute))`. Append results in `tool_call_id` order before the next LLM call.
2. **`agents.active` status item.** Today a single string. Parallel needs either a counter or a Set.
3. **Cancellation fan-out.** Already plumbed via `ctx.signal`; needs verification under test.
4. **prompt-system race.** A sub-dispatch triggering `prompt:rebuilt` mid-parent-turn could surface different system prompts to siblings. Edge case; add a regression test, not architectural.

**Code-mode dispatch already supports parallel for free** — the LLM writes `await Promise.all([dispatch_agent(...), dispatch_agent(...)])` in the generated TS, and the existing sandbox runs it. The decompose-then-fan-out pattern works in code-mode the moment session-manager lands.

**No session-manager changes** are required for parallel: each sub-dispatch hits a different `events.jsonl`/`snapshot.json`, no contention.

## Breaking changes and rollout

| Plugin | Change | Bump |
|---|---|---|
| `llm-events` | Remove `session:*` (REPL events); add `harness:*`; add new `session:*` (record events) | **major** |
| `llm-driver` | Drops `state.messages`; consumes `sessions:store` (required); `runConversation` signature changes; emits `harness:*`, `session:active-changed` | **major** |
| `llm-agents` | `dispatch_agent` schema gains `session_id`; handler reads `ctx.sessionId`; sub-sessions go through `sessions:store` | **major** |
| `llm-tools-registry` | `ToolExecutionContext.sessionId` (additive but required by agents) | **minor** (or major if currently semver-strict) |
| `llm-session-manager` | New plugin | n/a |
| `llm-slash-commands` | Adds `/session:*` commands; `/clear` archives instead of in-place wiping | **minor** |
| `llm-status-items` (and any other `session:*` REPL subscriber) | Rename listeners to `harness:*` | **patch** |

**Rollout order:**

1. `llm-events` vocab change.
2. `llm-session-manager` ships standalone with tests passing.
3. `llm-driver` + `llm-agents` + `llm-tools-registry` updated together (atomic — they share the `ToolExecutionContext.sessionId` contract and the new `runConversation` signature).
4. Other subscribers patched.
5. `harnesses/openai-compatible.json` updated to include `llm-session-manager`.

The harness is pre-1.0; clean breaks are acceptable. No back-compat aliases.

## Testing

Matches existing `bun:test` patterns in `llm-driver/test` and `llm-agents/test`.

**`llm-session-manager` unit tests** — pure modules with injected fakes (`{ readFile, writeFile, fsync, listDir, atomicRename, now, log }`):

- Storage layout creation under a tmp dir.
- Snapshot atomicity (writer crash mid-write does not corrupt the existing snapshot).
- Events append + offset monotonicity.
- Index recovery from missing/corrupt index (rebuild by walking).
- Alias collision throws.
- `childId` validation regex.
- Cascade delete touches only descendants.
- `readEvents()` honors `fromOffset` / `limit`.
- `harnessKey()` covers ref-with-version, ref-without-version, single-file json path, directory-style path, and missing-both fallback.

**Integration test** — single test against a tmp dir:

- Spin up real `llm-session-manager` + a fake `llm:complete` + fake `tools:registry` + real `llm-driver`.
- Round-trip: create session → run turn (with one tool call) → commit → manager reload (simulate restart) → resume → run another turn → assert events.jsonl has the expected ordered sequence and snapshot.json has the expected messages.
- Cancel-rollback: start a turn, append, abort signal, assert rollback restored prior message count and snapshot is unchanged.

**`llm-driver` test updates** — existing tests in `integration.test.ts` and `system-prompt-integration.test.ts` get a fake `sessions:store` injected via deps. A test helper builds the fake. Cancel-rollback test asserts `TurnHandle.rollback()` was called instead of asserting `state.messages` reverted.

**`llm-agents` test updates** — `dispatch.ts` tests get a fake `sessions:store` and `ToolExecutionContext.sessionId`. New tests:

- "same session_id continues history" (dispatch twice with same id, second sees first's messages).
- "different agent_name on existing session_id throws."
- "omitted session_id creates a fresh oneshot session."
- "depth still enforced regardless of session reuse."

**Crash-safety test:**

- Write a partial line to `events.jsonl`. Instantiate manager. Verify recovery truncates to last `\n`.
- Write a `snapshot.json.tmp` without rename. Verify it's ignored on load.
- Corrupt the index. Verify rebuild from disk walk produces the same listing.

## Open questions / explicit deferrals

- **Concurrent driver-sessions UX.** This spec preserves the design space (multiple sessions can have open turns concurrently) but the interactive driver still drives one-at-a-time. A future "multiplex driver" plugin can adopt this contract without further session-manager changes.
- **Sub-session retention policy.** All dispatches persist in v0. v1 likely wants TTL or "delete with parent." Not designed here.
- **Meta-harness analysis tooling.** This spec exposes `readEvents()` and the on-disk layout; the analysis agent itself is a separate plugin/effort.
- **Token-aware snapshot pruning.** A future feature; the snapshot is the entire history today. The event log is the source for any history-replay use case.

## Glossary

- **Session** — a conversation. Owns a `ChatMessage[]` (the canonical history) and an event log (the execution trace). Has an id, optional alias, optional parent.
- **Top-level session** — `parentSessionId == null`. Created by the driver (interactive) or programmatically.
- **Sub-session** — `parentSessionId != null`. Created by `dispatch_agent` (or any plugin calling `sessions.create({ parentSessionId, childId })`).
- **Turn** — one user-input → assistant-final-output cycle within a session. May invoke many LLM calls and many tools. Identified by `turnId`.
- **TurnHandle** — the rollback boundary. Returned by `beginTurn(sessionId, turnId)`. Buffers appends until `commit()` or `rollback()`.
- **Event log** — append-only `events.jsonl` capturing the full execution trace (LLM payloads, tool calls, errors, timings).
- **Snapshot** — the canonical conversation state on disk. Single JSON file, rewritten atomically per turn-commit.
- **Harness key** — derived stable string from `ctx.harness.{ref|jsonPath}` used to namespace storage.
