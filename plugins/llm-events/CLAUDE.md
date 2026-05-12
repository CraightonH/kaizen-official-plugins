# Working in `llm-events`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts        Plugin lifecycle. Declares VOCAB (frozen), CANCEL_TOOL,
                CODEMODE_CANCEL_SENTINEL. setup() defines the
                `llm-events:vocabulary` service, provides VOCAB as its impl,
                and calls ctx.defineEvent() once per VOCAB value.
                The only file that touches `ctx`.
public.d.ts     Foundation TypeScript contract for the harness:
                Vocab, EventName, ChatMessage, ToolCall, ToolSchema, ModelInfo,
                LLMRequest, LLMResponse, LLMStreamEvent, LLMCompleteService,
                CANCEL_TOOL, and CODEMODE_CANCEL_SENTINEL. No runtime code —
                type-only import surface for peers. Service-specific contracts
                belong in the plugin that owns the service behavior.
index.test.ts   Bun-test suite: VOCAB shape/freeze, sentinel identity,
                lifecycle (defineEvent + provideService), foundation type
                probes, and checks that owner-specific contracts are absent.
```

Boundaries:
- `index.ts` is the only stateful module. `public.d.ts` is types-only.
- This plugin is a leaf: no `services.consumes`, no event subscriptions, no I/O.
- Tests run independently (`bun test`) and use a hand-rolled fake `ctx`.

## Invariants

- **Single owner of the shared vocab.** This plugin is the *only* one that calls `ctx.defineEvent()` for any name in `VOCAB`. Peer plugins emit and subscribe — they never define. Re-defining a name elsewhere is a wiring bug; the harness will reject it.
- **VOCAB is frozen.** `Object.isFrozen(VOCAB) === true`. Tests assert this. Don't replace the freeze with a runtime mutable map.
- **Names are stable wire identifiers.** Renaming or removing a key is a breaking change for every peer plugin. Treat the literal string values as a public ABI.
- **Type identity matters.** Each VOCAB value is typed as its own string literal (`readonly LLM_TOKEN: "llm:token"`). Peers rely on this for narrowed event-payload typing. New entries must follow the same pattern in `public.d.ts`.
- **Sentinels are well-known.** `CANCEL_TOOL === Symbol.for("kaizen.cancel")` and `CODEMODE_CANCEL_SENTINEL === "__kaizen_cancel__"`. Other plugins compare against these by identity / equality; do not change the underlying values.
- **No service consumption.** Adding `services.consumes` here would invert the dependency graph — every plugin depends on `llm-events`, so it cannot depend on anything in the harness.

## Adding a new event

1. Pick a `namespace:kebab-name` string. Group it with an existing area (session, turn, llm, tool, codemode, skill, status, prompt) or open a new namespace.
2. Add the literal in `VOCAB` in `index.ts`.
3. Add the matching `readonly KEY: "namespace:name"` entry in the `Vocab` interface in `public.d.ts`.
4. Update `index.test.ts`:
   - Add the literal to the `expected` set in the "VOCAB contains every Spec 0 event name" test.
   - Add a `VOCAB.NEW_KEY` assertion to one of the spot-check tests if it belongs to a covered area.
5. Bump `package.json` minor version — this is a public-surface change for every consumer.
6. Document the event's payload shape in the *consuming* / *emitting* plugin's README; this plugin only owns the name.

Do **not** add `defineEvent` calls in any other plugin for names declared here. If a peer plugin needs an event that's specific to itself (not part of the shared vocab), it can define and own that name privately; only names in `VOCAB` are owned here.

## Adding a new shared type

Foundation primitives belong in `public.d.ts`. Service-specific contracts
(`*Service` interfaces and their payload types like `*Manifest`, `*Context`,
etc.) should live in the owning plugin's own `public.d.ts`.

Do not add contracts here if their shape requires importing another harness
plugin. `llm-events` must remain dependency-free; put that contract in the
owning plugin's `public.d.ts` instead.

When considering a new service interface:
- Put it in the plugin that provides the service.
- Export it through that plugin's `public.d.ts` and package `exports`.
- Import foundation primitives from `llm-events/public` as needed.
- Add owner-plugin tests that lock the public shape.
- Avoid adding compatibility exports here unless a documented migration requires
  it and includes a removal plan.

## Testing

```bash
cd plugins/llm-events && bun test
```

`bun:test` only — no external mocking. The `makeCtx()` helper at the top of `index.test.ts` mocks the Kaizen ctx surface this plugin uses (`defineEvent`, `defineService`, `provideService`).

## Local deploy

The Kaizen runtime prefers the bundled `dist/index.js` over source. After editing, the plugin must be re-bundled into the install dir:

```bash
cp -R plugins/llm-events/. ~/.kaizen/marketplaces/official/plugins/llm-events@0.7.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-events@0.7.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

Because every harness plugin depends on `llm-events`, redeploying this plugin without also redeploying peers that import its types is usually fine (types compile-time only) — but a VOCAB literal-string change requires every consumer to be rebuilt against the new `public.d.ts`.

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
