# llm-session-manager

- Keep `index.ts` as the only file that imports `kaizen/types` or touches the plugin lifecycle context.
- Storage modules should stay dependency-light and testable with tmp dirs.
- Public APIs must validate full session ids before deriving filesystem paths.
- `events.jsonl` is append-only and is not rolled back when a turn rolls back.
- `snapshot.json` is the canonical conversation state and must be written through temp-file + rename.
