# llm-events Refactor Opportunities

Date: 2026-05-12
Session target: llm-events

## Opportunity

Shared service contracts are duplicated between `llm-events/public.d.ts` and
the owning plugins' local `public.d.ts` or implementation files. That drift is
what left the foundation declarations stale after peer-plugin refactors.

## Evidence

- Files/functions involved: `plugins/llm-events/public.d.ts`,
  `plugins/llm-tools-registry/public.d.ts`,
  `plugins/llm-tools-registry/registry.ts`,
  `plugins/llm-slash-commands/registry.ts`,
  `plugins/llm-tui/public.d.ts`, `plugins/llm-tui/completion/registry.ts`.
- Concrete symptoms: `llm-events/public.d.ts` lagged tool provenance,
  slash-registry, skill-rescan, and TUI-completion changes that were already
  implemented by owner plugins.
- Existing tests that make the issue visible, if any: the new structural tests
  in `plugins/llm-events/index.test.ts` catch the current aligned shapes, but
  they do not prevent future owner/foundation drift by themselves.

## Scope

- Local to this plugin or cross-plugin: cross-plugin.
- Affected openai-compatible plugins: `llm-events`, `llm-tools-registry`,
  `llm-skills`, `llm-slash-commands`, `llm-tui`, `llm-driver`,
  `llm-native-dispatch`.
- Related contracts: shared service declarations and package public subpaths.

## Suggested Direction

- Proposed shape of the refactor: choose one source of truth per service
  contract. Either move shared service declarations fully into the owning
  plugin public surfaces and have consumers import from owners, or keep
  `llm-events` as the aggregator and make owner plugins re-export those exact
  declarations without redeclaring local copies. Add compatibility tests that
  assert owner-provided services satisfy the exported foundation type.
- Migration or sequencing notes: start with non-runtime type re-exports, then
  update consumers one service at a time. Avoid changing event vocabulary in
  the same pass.
- Risks: changing import paths touches many plugins and can create circular
  dependencies if owner contracts import higher-level plugin types.

## Not Done In This Session

The current session is bounded to a `llm-events` polish pass. Removing the
duplication requires coordinated owner-plugin edits and consumer import
migrations, which is larger than the isolated foundation check.
