# llm-session-manager

Persistent conversation sessions for the local harness.

The plugin provides `sessions:store`, a service that creates, loads, lists, deletes, and drives persistent sessions. Each session owns a canonical `ChatMessage[]` snapshot and an append-only `events.jsonl` trace under:

```text
~/.kaizen/sessions/<harness-key>/<session-id>/
```

Top-level sessions use manager-minted UUID ids. Sub-sessions are nested under a parent with caller-supplied child ids, for example:

```text
<parent-session-id>/reviewer-A
```

All message writes happen through `TurnHandle`. A committed turn atomically rewrites `snapshot.json`. A rolled-back turn discards buffered messages while leaving trace events intact for auditability. A partially-committed turn (cancellation path) drops a trailing assistant message with unresolved tool_calls and persists the rest; `events.jsonl` is not trimmed in either case.

## Configuration

Tunable via `config:store` (the shared harness config file under
`~/.kaizen/harnesses/<harness-key>/config.json`, edited via `kaizen-config`'s
`/config` slash commands):

| Field          | Type   | Default                       | Notes                                                            |
| -------------- | ------ | ----------------------------- | ---------------------------------------------------------------- |
| `sessionsBase` | string | `~/.kaizen/sessions` (absolute) | Root directory under which `<harness-key>/<session-id>/` lives. Resolved once at setup; changes require harness restart. |

Read once in `setup()` — there is no `watch()` subscription, so live edits do
not take effect until the next harness boot.
