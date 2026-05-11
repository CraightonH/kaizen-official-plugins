# llm-session-manager

- Keep `index.ts` as the only file that imports `kaizen/types` or touches the plugin lifecycle context.
- Storage modules should stay dependency-light and testable with tmp dirs.
- Public APIs must validate full session ids before deriving filesystem paths.
- `events.jsonl` is append-only and is not rolled back when a turn rolls back.
- `snapshot.json` is the canonical conversation state and must be written through temp-file + rename.
- `TurnHandle.partialCommit()` is the cancel-path persistence call. It drops a trailing `assistant` message with unresolved `toolCalls` and writes whatever remains; an empty post-trim buffer behaves like `rollback()`. `events.jsonl` is still append-only and is *not* trimmed — the debug trail may include the dropped trailing assistant; `snapshot.json` will not.
