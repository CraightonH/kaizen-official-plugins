# Working in `llm-events`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts        Plugin lifecycle. Declares VOCAB (frozen), CANCEL_TOOL,
                CODEMODE_CANCEL_SENTINEL. setup() provides VOCAB as the
                `events:vocabulary` service impl (defineService is in
                llm-contracts, not here), and calls ctx.defineEvent() once
                per VOCAB value.
                The only file that touches `ctx`.
public.d.ts     Runtime sentinels only: CANCEL_TOOL and
                CODEMODE_CANCEL_SENTINEL. All contract types (Vocab, EventName,
                ChatMessage, ToolCall, ToolSchema, ModelInfo, LLMRequest,
                LLMResponse, LLMStreamEvent, LLMCompleteService) now live in
                llm-contracts/public. Import from there, not here.
index.test.ts   Bun-test suite: VOCAB shape/freeze, sentinel identity,
                lifecycle (defineEvent + provideService), and foundation
                type probes.
```

Boundaries:
- `index.ts` is the only stateful module. `public.d.ts` is types-only.
- This plugin is a leaf: no `services.consumes`, no event subscriptions, no I/O.
  It defines `llm:complete` but does not provide an implementation.
- Tests run independently (`bun test`) and use a hand-rolled fake `ctx`.

## Invariants

- **Single owner of the shared vocab.** This plugin is the *only* one that calls `ctx.defineEvent()` for any name in `VOCAB`. Peer plugins emit and subscribe — they never define. Re-defining a name elsewhere is a wiring bug; the harness will reject it.
- **`defineService` belongs in `llm-contracts`, not here.** The `events:vocabulary` contract is defined by `llm-contracts`. This plugin only calls `ctx.provideService("events:vocabulary", VOCAB)`.
- **VOCAB is frozen.** `Object.isFrozen(VOCAB) === true`. Tests assert this. Don't replace the freeze with a runtime mutable map.
- **Names are stable wire identifiers.** Renaming or removing a key is a breaking change for every peer plugin. Treat the literal string values as a public ABI.
- **Type identity matters.** Each VOCAB value is typed as its own string literal (`readonly LLM_TOKEN: "llm:token"`). Peers rely on this for narrowed event-payload typing. New entries must follow the same pattern in `llm-contracts/contracts/events.ts`.
- **Sentinels are well-known.** `CANCEL_TOOL === Symbol.for("kaizen.cancel")` and `CODEMODE_CANCEL_SENTINEL === "__kaizen_cancel__"`. Other plugins compare against these by identity / equality; do not change the underlying values.
- **No service consumption.** Adding `services.consumes` here would invert the dependency graph — every plugin depends on `llm-events`, so it cannot depend on anything in the harness.

## Adding a new event

1. Pick a `namespace:kebab-name` string. Group it with an existing area (session, turn, llm, tool, codemode, skill, status, prompt) or open a new namespace.
2. Add the literal in `VOCAB` in `index.ts`.
3. Add the matching `readonly KEY: "namespace:name"` entry in the `Vocab` interface in `llm-contracts/contracts/events.ts` (the `Vocab` type lives in `llm-contracts`, not in `llm-events/public.d.ts`).
4. Update `index.test.ts`:
   - Add the literal to the `expected` set in the "VOCAB contains every Spec 0 event name" test.
   - Add a `VOCAB.NEW_KEY` assertion to one of the spot-check tests if it belongs to a covered area.
5. Bump `package.json` minor version — this is a public-surface change for every consumer.
6. Document the event's payload shape in the *consuming* / *emitting* plugin's README; this plugin only owns the name.

Do **not** add `defineEvent` calls in any other plugin for names declared here. If a peer plugin needs an event that's specific to itself (not part of the shared vocab), it can define and own that name privately; only names in `VOCAB` are owned here.

## Adding a new shared type

Cross-plugin contract types belong in `llm-contracts/public.d.ts`, not here.
`llm-events/public.d.ts` is reserved for runtime-value exports (`CANCEL_TOOL`,
`CODEMODE_CANCEL_SENTINEL`) that are implementation details of this provider.

When adding a new service interface for another plugin:
- Put the type in `llm-contracts/contracts/<topic>.ts`.
- Re-export from `llm-contracts/public.d.ts`.
- Add `defineService` in `llm-contracts/index.ts`.
- Import foundation primitives (e.g. `ToolSchema`) from `llm-contracts/public` as needed.
- Avoid adding compatibility re-exports here unless a documented migration requires it and includes a removal plan.

## Testing

```bash
cd plugins/llm-events && bun test
```

`bun:test` only — no external mocking. The `makeCtx()` helper at the top of `index.test.ts` mocks the Kaizen ctx surface this plugin uses (`defineEvent`, `defineService`, `provideService`).

## Local deploy

Build from the source directory (where workspace deps resolve), then sync into the install dir:

```bash
PLUGIN=llm-events
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

Because every harness plugin depends on `llm-events`, a VOCAB literal-string change requires every consumer to be rebuilt against the new `llm-contracts/contracts/events.ts`.

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
