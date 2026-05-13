# Repository Guidance

These instructions apply to all feature work in this repository. Treat them as
the default design lens before adding or changing a plugin service.

## Service Ownership

Kaizen service wiring separates three roles:

- `defineService(name, spec)` declares that a contract exists and names its
  owner.
- `provideService(name, impl)` binds one runtime implementation for an already
  defined contract.
- `consumeService(name)` declares a hard runtime dependency on a contract.

The acid test for any service change:

> Remove the plugin that provides this service. Replace it with a stub plugin
> that imports the contract type from `llm-contracts/public` and calls
> `provideService` for the same contract IDs. The harness boots, and every
> other plugin in the harness functions or degrades cleanly. No other plugin
> in the repo needed to change.

If the answer is "I'd have to edit a consumer to switch providers," the
contract is owned in the wrong place.

## The Contracts Plugin Pattern

The openai-compatible harness uses a dedicated `llm-contracts` plugin:

- It is the **sole** site of `defineService` for every cross-plugin contract
  in the harness.
- It exports every cross-plugin contract type from `llm-contracts/public`.
- It has zero runtime behavior — no `provideService` calls, no event
  subscriptions, no UI mutation, no dependency on any other plugin.
- Implementation plugins import contract types from `llm-contracts/public`,
  never from each other.

A type is "cross-plugin" if any plugin other than its provider references
it. If it lives only inside the provider, it stays in the provider's own
`public.d.ts` (or stays unexported). See `plugins/llm-contracts/README.md`
for the complete list and the recipe for adding a new contract.

When you are tempted to define a contract inside the plugin that provides
it — stop. That coupling is exactly what `llm-contracts` exists to prevent.

## Naming Convention for Contract IDs

`<domain>:<role>` — both halves lowercase, kebab-case allowed, exactly one
colon, no plugin-name prefixes ever.

- `<domain>` is a concept noun (`ui`, `tools`, `dispatch`, `sessions`,
  `events`, `prompt`, `skills`, …) — never the name of the providing plugin.
- `<role>` describes what kind of contract it is (`registry`, `store`,
  `channel`, `vocabulary`, `complete`, `run-conversation`, …).

Names like `llm-tui:channel` or `prompt:system` are wrong — the first
encodes a provider, the second isn't a role. The right names are
`ui:channel` and `prompt:registry`.

## Required vs Optional Dependencies

A consumer can depend on a service in three ways. Pick the one that
matches the actual behavior:

1. **Hard.** Declare in `services.consumes` AND call `ctx.consumeService(id)`
   in setup AND call `ctx.useService<T>(id)` directly. The harness should
   refuse to boot the consumer if the provider is absent.

2. **Topo-hint optional.** Declare in `services.consumes` (so kaizen
   schedules the provider's setup first) but do NOT call `consumeService`.
   Call `ctx.useService<T>(id)` in setup; the lookup succeeds when the
   provider is loaded, and the call site can `if (!svc) { degrade; }` for
   the case where the provider is missing from the harness manifest.

3. **Deferred optional.** Do not declare in `services.consumes`. Look up
   via `ctx.useService<T>(id)` inside a deferred callback (an event handler,
   tool handler, slash handler, etc.) — anywhere that runs after every
   plugin's setup has completed. Wrap the lookup in `try`/`catch` if the
   service might not be defined at all.

Important: `ctx.useService()` **throws** when no provider is registered.
There is no "soft" variant that returns `undefined`. The whole reason the
topo-hint pattern exists is that kaizen orders plugins by their declared
`services.consumes` — without that hint, an optional lookup in `setup()`
will throw against a provider that loads later, even though the provider
is present in the harness.

Decision quickly:
- The plugin cannot function without it → **hard**.
- The plugin needs it during setup but can skip a feature if absent → **topo-hint**.
- The plugin only needs it at handler/event time → **deferred**.

Document the choice next to the `services.consumes` array in `index.ts`
and in the plugin README.

## Provider Swappability

Consumers depend on the narrowest stable contract, not a concrete
implementation plugin. If removing one provider should be recoverable by
loading another, the shared definition lives in `llm-contracts`, not in
the provider.

Before adding a new provider-like plugin, check whether it should:

- Provide an existing `llm-contracts` contract.
- Add a new contract to `llm-contracts` first.
- Register itself with a selector/registry service (a `*:registry`
  contract) instead of binding directly to a cardinality-one service.

Kaizen services are cardinality-one: only one plugin can provide a given
service name at runtime. If a feature needs multiple simultaneous
providers, design a `*:registry` contract so the registry handles
cardinality-N internally.

Where two plugins are candidate providers for the same cardinality-one
contract (e.g. `dispatch:strategy` could be provided by either
`llm-native-dispatch` or a future codemode-as-strategy plugin), the
harness manifest picks exactly one. Document the mutual exclusion in the
contract's module in `llm-contracts/contracts/`.

## Non-Contract Public Surface

A plugin's own `public.d.ts` is not necessarily empty after the contract
moves to `llm-contracts`. Implementation-internal types (config shapes,
internal state, runtime error classes) and runtime constants the
implementation owns can stay in the plugin's `public.d.ts`/`public.ts`.

The rule:

- A type that appears in any contract method's signature → in
  `llm-contracts/public`.
- A type, value, or class that is part of the implementation's specific
  error vocabulary or internal data, even if some consumer happens to
  catch/inspect it → stays in the plugin and document the dependency in
  the consumer's README.

Examples in this repo: `BareNamePluginError` and its siblings stay in
`llm-slash-commands` (they are concrete classes, not a contract);
`VOCAB` (the runtime frozen object) stays in `llm-events` while `Vocab`
(the type) lives in `llm-contracts`. See the per-plugin "non-contract
public surface" table in the design spec for the authoritative list.

## Review Checklist

For every service change, answer these before editing:

- Is the contract type in `llm-contracts/public`, or does it need to move
  there?
- Is the contract ID in `<domain>:<role>` form with no plugin-name prefix?
- Can another implementation reasonably slot in without changing
  consumers? (If not, see "Provider Swappability".)
- Is the dependency hard, topo-hint optional, or deferred optional? Does
  the `services.consumes` array, the `consumeService` call, and the
  `useService` call site agree on the answer?
- Are docs and tests locking the intended ownership boundary?
