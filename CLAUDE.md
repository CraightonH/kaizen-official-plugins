# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture principles

**Always read `docs/PLUGIN_ARCHITECTURE.md` before touching any service, contract, or `services.consumes` declaration.** It is the authoritative reference for:

- Service ownership (`defineService` / `provideService` / `consumeService`)
- The "contracts plugin" pattern (`llm-contracts` is the sole site of `defineService` for cross-plugin contracts in the local harness)
- Contract ID naming (`<domain>:<role>`, never plugin-name prefixes)
- Required vs topo-hint-optional vs deferred-optional dependencies
- Provider swappability and the cardinality-one rule

The acid test for any service change is in that doc — apply it before editing.

## Repo shape

Bun workspace monorepo. Every directory under `plugins/` is its own workspace; harness manifests live in `harnesses/`. The marketplace catalog is `.kaizen/marketplace.json`. The kaizen runtime itself is pulled in as a dev dep (`github:CraightonH/kaizen#vX.Y.Z` in the root `package.json`) — bump that pin to pick up runtime changes.

Most plugins have their own `CLAUDE.md` documenting that plugin's module map, invariants, and local-deploy notes — **read the plugin's CLAUDE.md before editing it**. The repo-level `README.md` lists every plugin with a one-line purpose.

## Commands

```sh
bun install                         # install workspace deps (run from repo root)
bun test                            # run all plugin tests
cd plugins/<name> && bun test       # run a single plugin's tests
cd plugins/<name> && bun test path/to/file.test.ts   # run a single test file
kaizen plugin validate plugins/<name>                # plugin manifest + structure check
```

Run a harness from the local checkout (no marketplace install needed):

```sh
kaizen --harness ./harnesses/local.json
kaizen --harness ./harnesses/claude-wrapper.json
```

## Working in this repo

- Always reference and incorporate principles from docs/PLUGIN_ARCHITECTURE.md when considering inter-plugin communication or building a new plugin. 
- Plugins are independent: tests, types, and bundles are per-plugin.
- Contracts (types crossing plugin boundaries) live in `plugins/llm-contracts/public.ts`. Implementation plugins import from `llm-contracts/public`, never from each other.
- `kaizen plugin validate plugins/<name>` is the contract for a publishable plugin; run it after manifest, permissions, or `public.d.ts` changes.
- Commits go straight to `main` in this repo. Skip the `document-and-commit` skill (TaxHawk-only workflow) — just `git commit` directly. No `Co-Authored-By` lines.
