# Working in `llm-contracts`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Invariants

- **Zero runtime behavior.** No `provideService`, no `ctx.on(...)`, no
  `useService`. Only `defineService` calls and type declarations.
- **No dependency on any other plugin.** Importing types from
  `llm-events/public` or `llm-driver/public` is forbidden — those types live
  here now.
- **One contracts/*.ts module per contract.** Don't merge unrelated contracts
  into one file even if they're short. The 1:1 mapping makes substitution and
  audit easier.
- **Every type a non-provider plugin needs lives in `public.d.ts`.** If a
  consumer plugin imports a type from anywhere other than `llm-contracts/public`,
  that type belongs here.

## Adding a contract

1. Create `contracts/<topic>.ts` with the interface(s), an exported
   `CONTRACT_ID` constant, and an exported `DESCRIPTION` constant.
2. Re-export the type(s) from `public.d.ts`.
3. In `index.ts`, import the module and add
   `ctx.defineService(<topic>.CONTRACT_ID, { description: <topic>.DESCRIPTION });`.

## Testing

This plugin has no runtime to test. Tests verify only that `defineService` is
called for every declared contract at setup time. Add cases to
`test/index.test.ts` as contracts are added.

## Local deploy

```bash
cp -R plugins/llm-contracts/. ~/.kaizen/marketplaces/official/plugins/llm-contracts@0.1.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-contracts@0.1.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```
