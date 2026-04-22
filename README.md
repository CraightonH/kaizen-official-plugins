# kaizen-official-plugins

First-party plugins and harnesses for [kaizen](https://github.com/CraightonH/kaizen).

## Status — rewrite in progress

The previous PoC plugins (`core-driver`, `core-events`, `core-ui-terminal`,
`core-executor-*`, `core-cli`, `core-plugin-manager`, `core-secrets`,
`timestamps`) and their harnesses were scrapped ahead of a production-ready
rewrite against kaizen v0.2.0 (service-registry model).

- The old code is preserved on the **`archive/poc`** branch and the
  **`pre-v0.2-rewrite`** tag.
- The catalog (`.kaizen/marketplace.json`) is intentionally empty until
  rewritten plugins land.
- `kaizen install official/<name>@<ver>` will fail against this marketplace
  until entries are added back.

Follow kaizen v0.2.0's service-registry spec
(`docs/superpowers/specs/2026-04-22-service-registry-merge-design.md` in the
kaizen repo) for the new plugin authoring model.

## Layout

```
.
├── .kaizen/
│   └── marketplace.json      # catalog: plugin + harness entries
├── plugins/                  # workspace packages (populated by rewrite)
│   └── <plugin>/
│       ├── package.json
│       ├── index.ts
│       ├── index.test.ts
│       ├── public.d.ts
│       └── README.md
└── harnesses/                # canonical-ref harness JSON files
    └── <name>.json
```

## Contributing a plugin

1. Scaffold: `kaizen plugin create plugins/<name>`.
2. Implement against `kaizen/types`. Tests, README, permissions, `public.d.ts`.
3. Validate: `kaizen plugin validate plugins/<name>`.
4. Add an entry under `.kaizen/marketplace.json#entries` (see the shape
   in `docs/reference/plugin-standards.md` in the `kaizen` repo).
5. Validate the catalog: `kaizen marketplace validate .`.
6. Open a PR.

Contributing a harness follows the same shape with `kind: "harness"`.

## Standards

See [`docs/reference/plugin-standards.md`](https://github.com/CraightonH/kaizen/blob/master/docs/reference/plugin-standards.md)
in the kaizen repo for the authoritative plugin requirements.
