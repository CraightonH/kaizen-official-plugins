# Working in `llm-tool-approval`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts             Plugin lifecycle. Reads services, wires the subscriber + slash + status item.
                     Registers config:store spec (topo-hint optional with DEFAULT_CONFIG fallback).
                     Only file that touches `ctx`.
config.ts            Pure: DEFAULT_CONFIG (frozen, built from defaults.json) + CONFIG_SCHEMA
                     for config:store. No I/O, no `ctx`.
public.d.ts          Plugin-internal ToolApprovalConfig type. Consumed only by config:store
                     registration and this plugin's own setup.
matcher.ts           Pure: domain derivation + match logic. Existing name-only matchers
                     (matches / matchesAny / deriveDomain) + parseRule / compilePattern /
                     matchRule / matchesAnyRule for argument-aware rules.
string-leaves.ts     Pure: DFS extractor for string-typed leaves in tool args.
bash-safety.ts       Pure: detects shell control characters in a bash command string.
                     First-match-wins; over-flags quoted metacharacters on purpose.
suggest-pattern.ts   Pure: derives a default pattern for "Approve Pattern Always"
                     (bash → first token + *, URL → *host/*, path → first two segments + /*).
persist.ts           Pure-ish: reads the project config file directly (via node:fs/promises)
                     to compute a project-scope delta, then calls cfgSvc.set(..., "project").
                     Best-effort writes per the "write failure ≠ approval failure" invariant.
subscriber.ts        Pure handler. DI for ui:prompt, matcher, config, channel/notice helpers.
                     Implements deny → bash-safety → allow → prompt; renders the
                     Approve Pattern Always option.
slash.ts             Three slash commands. Pure aside from the slash-registry registration call.
defaults.json        Shipped baseline allow-list. Loaded by config.ts into DEFAULT_CONFIG.
```

## Invariants

- **Subscriber is `async` and the bus dispatch is sequential.** Concurrent tool calls naturally serialize through one prompt at a time.
- **Pre-emption check first.** If `payload.args === CANCEL_TOOL` on entry, return immediately. Another subscriber already cancelled this call; do not prompt.
- **Deny wins regardless of source.** Resolution is `deny → allow → prompt`. A `deny` in any source short-circuits.
- **Prompt is the only place that writes config.** Approve Once does not touch disk. "Approve Always" / "Approve Domain Always" append to project config (or global if no project).
- **`config:store` is the only path that owns allow/deny persistence.** The plugin never writes config files directly — `persist.ts` computes a project-scope delta and hands it to `cfgSvc.set(..., "project")`. `ConfigSpec.defaults` comes from `defaults.json`; user overrides live in home/project layers of the harness `config:store`.
- **Write failure ≠ approval failure.** If the persistence write fails, still resolve as approve-once and write a notice. The foreground intent is the user's decision; bookkeeping is best-effort.
- **No `useService("ui:prompt")` until `harness:start`.** Service lookup at `setup()` may race with `llm-tui`'s `provideService`. Defer to `harness:start` like `llm-tools-registry` does.
- **Deny is absolute.** Bash safety overrides `allow` but never `deny`.
- **Bash safety override only applies to `name === "bash"`** and inspects `args.command`. Other tools are unaffected.
- **Safety-flagged prompts hide Always / Domain Always / Pattern Always options.** A chained or unparseable command cannot be sensibly persisted as a future allow rule.
- **Arg patterns are evaluated per-rule, never aggregated across rules.** Two pattern rules in `allow` do not combine — each must independently match its own pattern against some string leaf.
- **Pattern matching is "any string leaf matches".** Pattern rules over-match for multi-string args; documented in README.

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
