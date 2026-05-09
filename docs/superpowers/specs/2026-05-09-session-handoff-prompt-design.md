# Autonomous Session Handoff with Seeded Prompt

**Status:** Design approved 2026-05-09
**Scope:** `llm-session-manager`, `llm-driver`, `llm-tui` (plus event-bus contract usable by any plugin)
**Origin:** `docs/TODO.md` item #2

## Goal

Let the LLM autonomously decide that the current session's context has grown bloated and continue its work in a fresh session — without losing the work in flight. The LLM writes a starter prompt for its successor and the harness (a) archives the current session, (b) mints a new top-level session seeded with that prompt, and (c) by default begins inference on the seeded prompt immediately.

A human escape hatch exists: the LLM can request the seeded prompt land in the input buffer as a draft for human review rather than autostarting.

## Non-goals

- Automatic context summarization or compaction. The LLM authors the handoff prompt itself; no plugin generates one on its behalf.
- Carrying forward conversation state, memory entries, or skills automatically. Other plugins MAY subscribe to the handoff event and do so, but that is out of scope for v1.
- Sub-agent / child-session handoffs. Handoff applies to top-level sessions only, matching today's `session:new` semantics.
- Multi-session merging or branching beyond the linear archive→new pattern.

## API surface

### Tool: `session:new` (augmented; backward compatible)

```json
{
  "name": "session:new",
  "description": "Archive the current session and start a fresh one. Optionally seed the new session with a starter prompt — useful when context has grown bloated and you want to continue work in a clean session. With autostart=true (default), the new session immediately runs inference on the seeded prompt; with autostart=false, the prompt lands in the user input as a draft for the human to review.",
  "parameters": {
    "type": "object",
    "properties": {
      "prompt": {
        "type": "string",
        "description": "Starter prompt for the new session. The new LLM sees this as its first user turn."
      },
      "autostart": {
        "type": "boolean",
        "description": "If true (default), inference begins immediately in the new session. If false, the prompt is queued as a draft for the human to review."
      }
    },
    "additionalProperties": false
  }
}
```

Returns `{ from: SessionId, to: SessionId, seeded: boolean }`.

Backward compatibility: zero-arg invocation (`session:new({})`) behaves identically to today — archive + mint + switch, no seeded turn, no `session:handoff` event.

### Slash: `/session:new`

| Invocation | Behavior |
|---|---|
| `/session:new` | Bare; unchanged from today. |
| `/session:new <free text>` | `prompt = <free text>`, `autostart = true`. |
| `/session:new --draft <free text>` | `prompt = <free text>`, `autostart = false`. |

Slash dispatch translates to the same underlying tool/command path so the event contract is identical regardless of trigger.

## Event contract

A new lifecycle event on the existing event bus:

```
session:handoff  { from: SessionId, to: SessionId, prompt: string, autostart: boolean }
```

- Emitted by `llm-session-manager` after archive + seed-write + active-session-switch all complete.
- The pre-existing `session:switched { from, to }` event still fires for every active-session change (resume, new, handoff). `session:handoff` is strictly additive — the higher-semantic "LLM-authored continuation occurred" signal.
- Never emitted when `prompt` is absent (a plain archive+switch is `session:switched` only).

### Subscribers (v1)

- **`llm-driver`** — on `autostart=true`: cancels the in-flight turn-loop continuation in the (now archived) session and dispatches a fresh turn against the new active session, whose tail is already a pending user turn. On `autostart=false`: no-op.
- **`llm-tui`** — renders the handoff badge on any message whose `meta.handoff` is set. On `autostart=false`: populates the input buffer with `prompt` as a draft (user can edit/submit/discard).
- **`llm-events`** — logs the event with the full payload as part of its normal append.

### Future subscribers (out of scope, but the contract enables them)

`llm-memory` carry-forward, `llm-skills` re-prime, telemetry, etc. They subscribe to `session:handoff` like any other plugin; no further coordination required.

## Snapshot & rendering

The new session's `snapshot.json` starts with exactly one message:

```json
{
  "role": "user",
  "content": "<prompt>",
  "meta": { "handoff": { "from": "<fromSessionId>" } }
}
```

`meta.handoff` is the single source of truth for:

1. TUI badge rendering (e.g., `[handoff from session abc123]`).
2. Future plugins inspecting handoff provenance.

No new message role, no new message type. Mechanically the seeded turn is a `role: user` message indistinguishable from a typed one to the LLM and to existing transcript consumers; only the `meta` is novel.

The archived session is written through the existing temp-file + rename path. `events.jsonl` gets one final append recording the `session:handoff` event for the archived session's history; the new session's `events.jsonl` records the same event as its first entry.

## Control flow / ordering

`session:new` tool handler, on receiving `{ prompt, autostart }`:

1. Validate (see Validation below).
2. Wait for the current turn's trailing assistant message (if any) to be flushed to the current session's `snapshot.json`. The tool result for *this very call* must also land in the archived session's transcript.
3. Archive the current snapshot.
4. Mint a new top-level session id; write its initial `snapshot.json` with the seeded user turn carrying `meta.handoff.from = <archivedSessionId>`.
5. Switch the active-session pointer to the new session.
6. Emit `session:handoff { from, to, prompt, autostart }`.
7. Return `{ from, to, seeded: true }` to the caller.

Driver's response to `session:handoff` with `autostart=true`:

- The LLM's tool result has already been delivered into the archived session by the time the event fires, so cancellation does not lose the round-trip.
- The driver cancels any pending continuation of the archived session's turn loop (this prevents the LLM from generating a stray follow-up assistant message in a dead session).
- The driver then begins a new turn against the (now active) new session, which has a pending user turn at the tail. Inference begins immediately.

Driver's response with `autostart=false`: no-op. TUI handles the draft.

## Validation

| Inputs | Result |
|---|---|
| no `prompt`, no `autostart` | Backward-compatible behavior: archive+switch, no handoff event. |
| no `prompt`, `autostart=true` | Reject with tool error: `autostart requires a non-empty prompt`. |
| no `prompt`, `autostart=false` | Reject with same error. |
| empty/whitespace `prompt` | Reject with tool error: `prompt must be non-empty`. |
| `prompt` non-empty, `autostart=true` (default) | Proceed; emit handoff with `autostart=true`. |
| `prompt` non-empty, `autostart=false` | Proceed; emit handoff with `autostart=false`. |
| Active session is a child/agent session | Reject with tool error: `handoff is supported only for top-level sessions`. |

`autostart` defaults to `true` when `prompt` is provided.

## Testing

- **`tools.test.ts`** — parameter validation matrix (every row in the Validation table).
- **`slash.test.ts`** — `/session:new`, `/session:new foo bar`, `/session:new --draft foo bar`. Assert correct `prompt`/`autostart` translation.
- **New `handoff.test.ts`** (integration) —
  - Invoke `session:new({ prompt, autostart: true })`.
  - Assert event ordering: `archive → seed-write → switch → emit`.
  - Assert `session:handoff` fired exactly once with the correct payload.
  - Assert new snapshot has the seeded user turn with `meta.handoff.from` pointing to the archived session.
  - Assert archived snapshot is sealed and contains the trailing assistant message + tool result from the triggering turn.
- **Driver test** — subscribes to `session:handoff`, verifies it dispatches a turn against the new session when `autostart=true` and no-ops when `false`.
- **TUI test** — handoff badge renders on messages with `meta.handoff` set; draft buffer populated when `autostart=false`.

## Open considerations (deliberately deferred)

- **Multi-hop handoff chains.** `meta.handoff.from` is a single pointer; walking the chain works trivially. No `to` pointer is added to the archived session in v1 (we can derive it from event log if needed later).
- **Plugin-authored handoffs.** Any plugin could in principle invoke the same code path. v1 ships only the LLM-driven path; nothing in the design forecloses other triggers.
- **Memory/skills carry-forward semantics.** `llm-memory` and `llm-skills` are free to subscribe to `session:handoff` and act, but their policies are their own design problem.
