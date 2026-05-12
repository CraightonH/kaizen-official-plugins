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

Do not assume one plugin must both define and provide every service it touches.
When a service is an ecosystem-level extension point, define it in the
ecosystem/foundation plugin and let implementation plugins only provide it.

## Foundation Contracts

Use a foundation plugin, such as `llm-events` in the openai-compatible harness,
for contracts that are all of these:

- Provider-neutral.
- Stable enough for multiple plugins to consume.
- Expected to have interchangeable implementations.
- Part of the ecosystem vocabulary rather than one feature's private behavior.

Example: `llm:complete` is defined by `llm-events` and provided by concrete LLM
provider plugins such as `openai-llm`.

Do not turn a foundation plugin into a dumping ground. Service contracts that
belong to one feature owner should stay with that owner.

## Feature-Owned Services

When a service represents a plugin's own product or orchestration API, that
plugin should define the service and usually provide it too.

Examples:

- `driver:run-conversation` belongs to `llm-driver`.
- `tools:registry` belongs to `llm-tools-registry`.
- `prompt:system` belongs to `llm-system-prompt`.

Consumers may depend on those services, but they are depending on the owning
feature contract, not a generic ecosystem primitive.

## Required vs Optional Dependencies

Use `services.consumes` and `ctx.consumeService()` only for hard requirements.
If a plugin can degrade when another service is absent, do not create a hard
consume edge just for discovery. Use guarded `ctx.useService()` lookups at the
point of use and document the optional behavior in the README.

Hard dependency failure is correct when the harness cannot function without the
contract. Optional integrations should fail closed or silently no-op as
appropriate for the user-facing behavior.

## Provider Swappability

Consumers should depend on the narrowest stable contract, not a concrete
implementation plugin. If removing one provider should be recoverable by loading
another provider, the shared service definition belongs outside the provider.

Before adding a new provider-like plugin, check whether it should:

- Provide an existing foundation-defined service.
- Define a new foundation contract first.
- Register itself with a selector/registry service instead of binding directly
  to a cardinality-one service.

Kaizen services are cardinality-one today: only one plugin can provide a given
service name at runtime. If a feature needs multiple simultaneous providers,
design an explicit registry or selector contract instead of loading multiple
providers for the same service.

## Review Checklist

For every service change, answer these before editing:

- Who owns the contract name and shape?
- Is this an ecosystem extension point or one plugin's feature API?
- Can another implementation reasonably slot in without changing consumers?
- Is the dependency hard, or can the plugin degrade when absent?
- Are docs and tests locking the intended ownership boundary?
