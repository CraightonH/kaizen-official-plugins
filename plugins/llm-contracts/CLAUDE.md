# Working in `llm-contracts`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Invariants

- **Zero runtime behavior.** No `provideService`, no `ctx.on(...)`, no
  `useService`. Only `defineService` calls and type declarations.
- **No dependency on any other plugin.** Importing types from
  `llm-events/public` or any other implementation plugin is forbidden — those
  types live here now.
- **One `contracts/*.ts` module per contract.** Don't merge unrelated contracts
  into one file even if they're short. The 1:1 mapping makes substitution and
  audit easier.
- **Every type a non-provider plugin needs lives in `public.ts`.** If a
  consumer plugin imports a contract type from anywhere other than
  `llm-contracts/public`, that type belongs here.

## What stays in implementation plugins (not here)

The rule: if a type appears in the public signature of a `provideService`
implementation (i.e., it is part of the service contract surface), it belongs
in `llm-contracts`. If it is internal to the plugin and no other plugin
references it, it stays in the plugin's own `public.d.ts`.

| Plugin | Stays in plugin (non-contract) | Notes |
|---|---|---|
| `llm-events` | `VOCAB` runtime constant | `VOCAB` is the provided value; the `Vocab` type is the contract. |
| `llm-session-manager` | `EventLogEntry` type; `harnessKey()` function | Session-manager-private types. `EventLogEntry` appeared in `SessionsStoreService.readEvents()` return type and was pulled into the contract during migration. |
| `llm-tools-registry` | (nothing extra) | All public exports are contract surface. |
| `llm-slash-commands` | Error classes: `BareNamePluginError`, `ReentrantSlashEmitError`, `DuplicateRegistrationError`, `InvalidNameError` | Concrete runtime classes thrown by the implementation. Consumers that catch them depend on the implementation, not the contract. |
| `llm-mcp-bridge` | `ResolvedServerConfig` | Implementation-internal config shape. |
| `llm-tui` | Internal Ink/render state types | Contract types (`UiChannelService`, `UiTheme`, `UiToolRenderer`, etc.) live here. |

- `ui-channel` now exposes `WriteOptions { markdown?: boolean }`; opts is additive on `writeOutput` / `writeNotice` / `writeUser`. Per-method default is consumer-side (`llm-tui`), not encoded in the contract.
- `ui-theme` now includes `thoughtsMarkdown: boolean` (default `true`); read by `llm-tui/HistoryView` to gate markdown rendering of expanded thought blocks.

## Adding a contract

1. Create `contracts/<topic>.ts` with the interface(s), an exported
   `CONTRACT_ID` constant, and an exported `DESCRIPTION` constant.
2. Re-export the type(s) from `public.ts`. If the module exports a runtime
   value, use `export { ... }` not `export type { ... }`.
3. In `index.ts`, import the module and add
   `ctx.defineService(<topic>.CONTRACT_ID, { description: <topic>.DESCRIPTION });`.
4. Follow the "How to add a new contract" recipe in `README.md` for the
   implementation and consumer updates.

## Testing

This plugin has no runtime behavior to test. Tests verify only that
`defineService` is called for every declared contract at setup time. Add a case
to `test/index.test.ts` as each contract is added.

```bash
cd plugins/llm-contracts && bun test
```

## Local deploy

Build from the source directory (where workspace deps resolve), then sync into the install dir:

```bash
PLUGIN=llm-contracts
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

`llm-contracts` must be redeployed before any plugin that calls `provideService`
for a contract defined here — it must boot first. It is listed as the first
plugin in `harnesses/openai-compatible.json`.
