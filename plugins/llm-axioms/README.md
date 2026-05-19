# llm-axioms

Session-scoped Aristotelean axiom workspace for the openai-compatible harness. Records first-principles axioms (statement + premises + reasoning + scope) derived during a session, persists them under `~/.kaizen/plugins/llm-axioms/sessions/<session-id>.json`, and injects them into every LLM turn alongside a static methodology section that teaches the model when to derive.

Axioms are **distinct from memories**: session-bound (not user/project), structured (with explicit premises and scope), ephemeral relative to broader durable context. If a derived axiom proves durable across problems, the user lifts it into `llm-memory` by hand.

## What it does

- Provides the `axioms:registry` service (defined in `llm-contracts`).
- Registers two `prompt:registry` sections:
  - `llm-axioms:methodology` (priority 50) — static guidance on when and how to derive first principles.
  - `llm-axioms:workspace` (priority 180) — current session's axioms, grouped by scope, truncated oldest-first to `injectionByteCap`. Drops when empty.
- Registers three tools in `tools:registry`: `axiom_record`, `axiom_amend`, `axiom_drop`. All tagged `["axioms", "write"]`. Validation failures return structured `{ ok: false, error }`.
- Registers three slash commands in `slash:registry`: `/axioms:list`, `/axioms:show <id>`, `/axioms:clear`.
- Subscribes to `session:active-changed` to swap the active session's axioms on session change.

## Wiring

### Provides

**Service** — `axioms:registry`

```typescript
interface AxiomEntry {
  id: string;             // [a-z0-9_-]{1,64}
  statement: string;
  premises: string[];
  reasoning: string;
  scope: string;
  derivedAt: number;
  amendedAt?: number;
}

interface AxiomsRegistryService {
  list(): readonly AxiomEntry[];
  get(id: string): AxiomEntry | null;
  record(entry: Omit<AxiomEntry, "derivedAt" | "amendedAt">): Promise<AxiomEntry>;
  amend(id: string, patch: Partial<Omit<AxiomEntry, "id" | "derivedAt">>): Promise<AxiomEntry>;
  drop(id: string, reason: string): Promise<boolean>;
  clear(): Promise<void>;
  onChange(cb: () => void): () => void;
}
```

### Consumes

- `events:vocabulary` — **hard**.
- `config:store` — topo-hint optional; falls back to `DEFAULT_CONFIG` if absent.
- `prompt:registry` — topo-hint optional; sections not registered if absent.
- `tools:registry` — topo-hint optional; tools not registered if absent.
- `slash:registry` — topo-hint optional; slash commands not registered if absent.
- Event `session:active-changed` — required for any writes; without it, tools return `{ ok: false, error: "no_active_session" }`.

## Configuration

Settings live under the `llm-axioms` plugin section in `config:store`:

| Key | Default | Notes |
|---|---|---|
| `axiomsDir` | `~/.kaizen/plugins/llm-axioms/sessions` | `~/` expanded. |
| `injectionByteCap` | `4096` | Workspace section cap; oldest-first truncation. |
| `methodologyEnabled` | `true` | Kill switch for the static section. |
| `workspaceEnabled` | `true` | Kill switch for the dynamic section. |
| `staleTempMs` | `60000` | Startup temp-file sweep threshold. |

## Privacy

All writes land as plain text under the configured directory. No outbound calls; axioms are sent only as part of the normal `llm:complete` request. Add `.kaizen/plugins/llm-axioms/` to your home backup policy if you want axioms to survive across machines.

## Permissions

`tier: unscoped` — reads/writes under `~/.kaizen/plugins/llm-axioms/`. No network, no process spawn.
