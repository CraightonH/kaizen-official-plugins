# Working in `llm-tool-approval`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts        Plugin lifecycle. Reads services, wires the subscriber + slash + status item.
                Only file that touches `ctx`.
matcher.ts      Pure: domain derivation + match logic (exact, prefix glob, catch-all).
config.ts      Pure functions + small fs surface. Loads three sources, picks write target,
                atomic write, dedupe + sort.
subscriber.ts  Pure handler. DI for ui:prompt, matcher, config, channel/notice helpers.
                Implements the tool:before-execute logic.
slash.ts       Three slash commands. Pure aside from the slash-registry registration call.
defaults.json  Shipped baseline allow-list.
```

## Invariants

- **Subscriber is `async` and the bus dispatch is sequential.** Concurrent tool calls naturally serialize through one prompt at a time.
- **Pre-emption check first.** If `payload.args === CANCEL_TOOL` on entry, return immediately. Another subscriber already cancelled this call; do not prompt.
- **Deny wins regardless of source.** Resolution is `deny → allow → prompt`. A `deny` in any source short-circuits.
- **Prompt is the only place that writes config.** Approve Once does not touch disk. "Approve Always" / "Approve Domain Always" append to project config (or global if no project).
- **Write failure ≠ approval failure.** If the persistence write fails, still resolve as approve-once and write a notice. The foreground intent is the user's decision; bookkeeping is best-effort.
- **No `useService("ui:prompt")` until `harness:start`.** Service lookup at `setup()` may race with `llm-tui`'s `provideService`. Defer to `harness:start` like `llm-tools-registry` does.

## Local deploy

```sh
PLUGIN=llm-tool-approval
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```
