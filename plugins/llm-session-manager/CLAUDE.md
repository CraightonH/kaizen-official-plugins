# llm-session-manager

- Keep `index.ts` as the only file that imports `kaizen/types` or touches the plugin lifecycle context.
- Storage modules should stay dependency-light and testable with tmp dirs.
- Public APIs must validate full session ids before deriving filesystem paths.
- `events.jsonl` is append-only and is not rolled back when a turn rolls back.
- `snapshot.json` is the canonical conversation state and must be written through temp-file + rename.
- `TurnHandle.partialCommit()` is the cancel-path persistence call. It drops a trailing `assistant` message with unresolved `toolCalls` and writes whatever remains; an empty post-trim buffer behaves like `rollback()`. `events.jsonl` is still append-only and is *not* trimmed — the debug trail may include the dropped trailing assistant; `snapshot.json` will not.

## Module map

```
index.ts         Plugin lifecycle. Only file touching ctx. Loads config via
                 the canonical config:store topo-hint pattern, registers
                 sessions:store, wires trace + lifecycle subscribers.
config.ts        DEFAULT_CONFIG (frozen) + CONFIG_SCHEMA for config:store.
                 Single knob: `sessionsBase` (default `join(homedir(), ".kaizen",
                 "sessions")` — resolved at module load because kaizen-config
                 does NOT tilde-expand string fields and the path is fed
                 directly into mkdirSync). Read once in setup(); changes
                 require harness restart.
public.d.ts      Re-exports contract types from llm-contracts/public plus
                 plugin-internal SessionManagerConfig interface.
store.ts         makeStore — disk-backed sessions:store implementation.
... (see source for paths.ts, snapshot.ts, events-log.ts, etc.)
```

Boundaries:
- Config defaults / schema live in `config.ts`; never inline them in `index.ts`.
- `SessionManagerConfig.sessionsBase` is required (no `?`) — the default makes
  it always populated after `cfgSvc.get()`.
