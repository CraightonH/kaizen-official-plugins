# kaizen-official-plugins

Official kaizen plugin marketplace. Hosts plugins and harnesses for [kaizen](https://github.com/CraightonH/kaizen) 0.3+.

## Plugins

- **claude-events** — event vocabulary for the claude-wrapper harness.
- **claude-tui** — terminal UI: rounded "kaizen" prompt box + status bar. Provides `ui:channel`.
- **claude-status-items** — emits `cwd` and `git.branch` status items.
- **claude-driver** — session driver; wraps the local `claude` CLI in headless stream-json mode.

## Harnesses

- **claude-wrapper** — Claude Code wrapper UI over `claude -p`. Requires the `claude` binary on `$PATH` and an authenticated Claude Code login (Pro/Max/Team/Enterprise OAuth, or API key).

## Usage

```sh
kaizen --harness official/claude-wrapper@0.1.0
```

Or run from a local checkout:

```sh
kaizen --harness ./harnesses/claude-wrapper.json
```

## Layout

```
.
├── .kaizen/
│   └── marketplace.json      # catalog: plugin + harness entries
├── plugins/
│   ├── claude-events/
│   ├── claude-tui/
│   ├── claude-status-items/
│   └── claude-driver/
└── harnesses/
    └── claude-wrapper.json
```

## Development

```sh
bun install
bun test
```

## Contributing a plugin

1. Scaffold: `kaizen plugin create plugins/<name>`.
2. Implement against `kaizen/types`. Tests, README, permissions, `public.d.ts`.
3. Validate: `kaizen plugin validate plugins/<name>`.
4. Add an entry under `.kaizen/marketplace.json#entries`.
5. Open a PR.

## Standards

See [`docs/reference/plugin-standards.md`](https://github.com/CraightonH/kaizen/blob/master/docs/reference/plugin-standards.md) in the kaizen repo.
