# kaizen-official-plugins

First-party plugins and harnesses for [kaizen](https://github.com/CraightonH/kaizen).

The kaizen binary ships with zero plugins — every plugin reaches users through the
Spec 1 marketplace install path. This repo is the catalog that powers the
default installer experience and the reference source for all first-party
plugins and harnesses.

## Add the official marketplace

```sh
kaizen marketplace add official https://github.com/CraightonH/kaizen-official-plugins.git
kaizen install official/core-anthropic@1.0.0   # a harness
```

## Layout

```
.
├── .kaizen/
│   └── marketplace.json      # catalog: plugin + harness entries
├── plugins/                  # workspace packages
│   └── <plugin>/
│       ├── package.json
│       ├── index.ts
│       ├── index.test.ts
│       └── README.md
└── harnesses/                # canonical-ref harness JSON files
    └── <name>.json
```

## Contributing a plugin

1. Scaffold: `kaizen plugin create plugins/<name>`.
2. Implement against `kaizen/types`. Tests, README, permissions.
3. Validate: `kaizen plugin validate plugins/<name>`.
4. Add an entry under `.kaizen/marketplace.json#entries` (see the shape
   in `docs/plugin-standards.md` in the `kaizen` repo).
5. Validate the catalog: `kaizen marketplace validate .`.
6. Open a PR.

Contributing a harness follows the same shape with `kind: "harness"`.

## Standards

See [`docs/plugin-standards.md`](https://github.com/CraightonH/kaizen/blob/master/docs/plugin-standards.md)
in the kaizen repo for the authoritative plugin requirements.
