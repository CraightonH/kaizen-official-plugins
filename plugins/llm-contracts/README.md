# llm-contracts

The contract foundation for the openai-compatible Kaizen harness. This plugin
defines every cross-plugin service contract and exports their TypeScript
types. It has zero runtime behavior — no `provideService` calls, no event
subscriptions, no UI mutation.

## Why this exists

Service contracts are the integration surface between plugins. If a contract
is defined inside the plugin that provides it, replacing that plugin with a
different implementation also removes the contract definition — every
consumer breaks. By centralizing definitions here, any implementation plugin
in the harness can be replaced by inserting a substitute that imports the
same types from `llm-contracts/public` and calls `provideService` with the
same contract IDs.

## What's inside

- `contracts/<topic>.ts` — one file per contract. Contains the TypeScript
  interface(s), the contract ID constant, and the description string.
- `index.ts` — calls `defineService` for every contract at plugin setup.
- `public.d.ts` — re-exports every contract type for consumers and providers
  to import.

## How to add a new contract

1. Add `plugins/llm-contracts/contracts/<topic>.ts` with the type, the
   contract ID, and the description.
2. Re-export the type from `public.d.ts`.
3. Add a `defineService` call in `index.ts`.
4. Ship implementation and consumer plugins that import from
   `llm-contracts/public`.

## Naming convention for contract IDs

`<domain>:<role>` — both halves lowercase, kebab-case allowed, exactly one
colon, no plugin-name prefixes. See the design spec for the full convention.
