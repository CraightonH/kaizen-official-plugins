# Centralized completion-menu filtering

## Problem

Slash-command popups across the harness don't consistently narrow as the
user types. There are six menus today and they behave four different ways:

| Menu | File | Current filter |
| --- | --- | --- |
| Slash-command name list (`/<...>`) | `llm-slash-commands/completion.ts:14-17` | `name.startsWith(query)` — prefix, case-sensitive |
| Slash flag list (e.g. `--project`) | `llm-slash-commands/arg-completion.ts:103-114` | none |
| `/config:* <plugin>` | `kaizen-config/slash-completions.ts:16` `pluginCompletions` | none (query never passed) |
| `/config:get` / `/config:unset` `<key>` | `kaizen-config/slash-completions.ts:70` `keyOnlyCompletions` | none (query never passed) |
| `/config:set <key>=<value>` key tier (pre-`=`) | `kaizen-config/slash-completions.ts:43-57` `keyEqualsValueCompletions` | none |
| `/config:set` value tier (post-`=`) | `kaizen-config/field-rendering.ts:119,126` `renderValueRows` | `startsWith(valueQuery)` — prefix, case-sensitive |

Beyond fixing the inconsistency, we want any future plugin that registers a
slash command to get this behavior **for free** — without having to remember
to call a filter helper at every callsite.

## Goal

Every completion menu in the harness narrows as the user types using one
rule: **case-insensitive substring of the in-progress token against the
item's `label`**. Empty query is a no-op (full list).

Filtering is centralized so any plugin registering a slash argument inherits
the behavior with no extra code. Slots whose query format is not a plain
substring of the item label (e.g. the `key=value` slot) opt out and own
their own filter.

## Design

### Where the filter lives

Two centralizing layers exist in the harness:

1. **Host completion registry** (`llm-tui/completion/registry.ts`) — owns
   the popup and merges results from every `CompletionSource`. It receives
   `q = slot.query` from the arg source's `match()`. For the `key=value`
   slot, `q = "backend=k"` while the rendered label is `✓ keychain` —
   a host-level filter would mis-handle this without a per-item filter-key
   contract addition.
2. **Slash-arg dispatcher** (`llm-slash-commands/arg-completion.ts`) — owns
   the `complete: (prev, query) => …` callback flow for every slash-command
   argument across every plugin.

We centralize at **(2)**. It's the natural locus for "every slash-arg slot
in every plugin" and lets us add a coarser-grained opt-out for unusual slot
formats without per-item complexity.

### Contract change

In `llm-contracts/contracts/slash-registry.ts`, add an optional field to
`ArgSlot`:

```ts
export interface ArgSlot {
  name: string;
  description?: string;
  complete?: (prev: string[], query: string) =>
    Promise<CompletionItem[]> | CompletionItem[];
  /**
   * When true, the slash-arg dispatcher will NOT post-filter results from
   * `complete`. The plugin is responsible for filtering against `query`
   * itself. Use only when `query` is structured (e.g. `key=value`) and
   * a label-substring filter would over-filter.
   */
  selfFilters?: boolean;
}
```

Default is `false`. No `llm-contracts` field is removed; this is purely
additive.

### Filter rule

Case-insensitive substring of `query` against `CompletionItem.label`:

```ts
function matchesQuery(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystack.toLowerCase().includes(q);
}

function filterByQuery<T extends { label: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => item.label.toLowerCase().includes(q));
}
```

`label`-only (not `detail`): users type what they see on the left of each
row. Matching on `detail` would surprise them (typing `string` would filter
fields by type; typing `home` would filter by source).

Substring (not prefix): handles `key` → `apiKey`. Not fuzzy / subsequence:
the menus are small and the deterministic test surface stays small.

### Changes by file

**`llm-contracts/contracts/slash-registry.ts`**

Add `selfFilters?: boolean` to `ArgSlot` (see above). No other changes.

**`llm-slash-commands/query-match.ts`** (new)

Export `matchesQuery` and `filterByQuery`.

**`llm-slash-commands/completion.ts`** (slash-name source)

Swap `name.startsWith(query)` for `matchesQuery(m.name, query)`. This source
is one of two registered directly with `UiCompletionService` and is not
routed through the arg dispatcher, so it self-filters. The change is local
and small.

**`llm-slash-commands/arg-completion.ts`** (arg dispatcher)

Two changes in `list()`:

1. Positional branch — after calling `fn(slot.prevArgs, slot.query)`, apply
   `filterByQuery(items, slot.query)` unless the slot has `selfFilters: true`:

   ```ts
   if (slot.slotIndex < args.length && !slot.flagMode) {
     const argSpec = args[slot.slotIndex]!;
     const fn = argSpec.complete;
     if (!fn) return [];
     const items = await fn(slot.prevArgs, slot.query);
     return argSpec.selfFilters ? items : filterByQuery(items, slot.query);
   }
   ```

2. Flag-slot branch — apply the same filter to the dispatcher-built flag
   list (no opt-out concept; the dispatcher constructs these items itself):

   ```ts
   return flags
     .filter((f) => !present.has(f.name))
     .filter((f) => matchesQuery(f.name, slot.query))
     .map<CompletionItem>((f) => ({ label: f.name, insertText: `${f.name} `, detail: f.description }));
   ```

**`kaizen-config/query-match.ts`** (new)

Same helper, duplicated to avoid a cross-plugin runtime dependency.
`llm-contracts` is types-only, so it can't host the implementation.
Two five-line files beats coupling foundational plugins.

**`kaizen-config/slash.ts`**

Mark the `key=value` slot for `/config:set` with `selfFilters: true`:

```ts
arguments: [
  { name: "plugin",    complete: () => pluginCompletions(deps.store) },
  { name: "key=value", complete: (prev, query) => keyEqualsValueCompletions(deps.store, prev, query), selfFilters: true },
],
```

No other arg-slot definitions change — `pluginCompletions` and
`keyOnlyCompletions` slots stay as today and inherit dispatcher filtering
for free.

**`kaizen-config/slash-completions.ts`**

- `pluginCompletions(store)` — unchanged. Dispatcher filters its result.
- `keyOnlyCompletions(store, prev)` — unchanged. Dispatcher filters.
- `keyEqualsValueCompletions(store, prev, query)` — the `eqIdx === -1`
  (key tier) branch applies `filterByQuery(rows, query)` before returning,
  because this slot has `selfFilters: true` and the plugin owns its filter
  for both tiers. The post-`=` branch already filters via `renderValueRows`.

**`kaizen-config/field-rendering.ts`**

`renderValueRows` swaps `startsWith(valueQuery)` for `matchesQuery(v, valueQuery)`
in both branches (boolean and enum). The function is unchanged in shape and
the slot already self-filters; this just makes the rule consistent
(substring + case-fold).

### What stays the same

- `CompletionItem` shape, `sortWeight` semantics, the `✓ value · source
  type` detail format, the field-tier `key=` pre-fill rule.
- Host registry coalescing, debounce, async cancellation, per-source error
  swallowing.
- Slash-command name sort order (built-in > file > plugin-namespaced; alpha
  within rank).
- Plugin/key slot callbacks in `kaizen-config` — same code paths, just
  filtered by the dispatcher on the way out.
- The `key=value` slot's two-tier rendering logic.

## Testing

### `plugins/llm-contracts/test/index.test.ts`

No new test required. `selfFilters` is a type-only addition with no runtime
behavior in this plugin (`llm-contracts` only calls `defineService`).

### `plugins/llm-slash-commands/query-match.test.ts` (new)

- Empty / whitespace query is a no-op.
- Case-insensitive substring (not just prefix).
- Label-only matching (`filterByQuery` ignores `detail`).

### `plugins/llm-slash-commands/test/completion.test.ts`

- New: substring match anywhere in the name (`config` → `/config:get`).
- New: case-fold (`HELP` → `/help`).
- Convert the existing `"filters by prefix"` test to `"filters by substring"`.
- Existing `"filters by namespace prefix"` test passes unchanged (substring
  is a superset of prefix).
- Existing sort-order assertion preserved.

### `plugins/llm-slash-commands/arg-completion.test.ts`

- New: positional slot — dispatcher filters returned items by `slot.query`
  unless the slot has `selfFilters: true`.
- New: positional slot — when `selfFilters: true`, dispatcher returns
  plugin items unchanged (no filter).
- New: flag slot — items filtered by `slot.query` against `f.name`,
  case-folded.
- New: flag slot — empty `slot.query` returns all unconsumed flags (the
  existing assertion stays green).

### `plugins/kaizen-config/query-match.test.ts` (new)

Same coverage as the llm-slash-commands helper test.

### `plugins/kaizen-config/slash-completions.test.ts`

- The existing `pluginCompletions` and `keyOnlyCompletions` tests pass
  unchanged (no signature change).
- Key tier of `keyEqualsValueCompletions`: new substring + case-fold tests;
  empty-query case stays green.
- Value tier: convert prefix tests to substring + case-fold.

### `plugins/kaizen-config/field-rendering.test.ts`

- Convert the two `"... by valueQuery prefix"` tests to substring + case-fold.
- Add a case-fold case (`"KEY"` → `keychain`).

## Risk and migration

- **Behavior change on three menus that previously didn't filter** (plugin
  tier, key tier in `keyOnly` and pre-`=` `keyEqualsValue`, flag list):
  they now narrow as you type. Pure improvement.
- **Behavior change on two menus that filtered via prefix** (slash-name,
  value tier): prefix → substring. Substring is strictly more permissive,
  so any prior match still matches.
- **Behavior change for any external plugin that registers slash arguments
  whose returned items rely on the dispatcher NOT filtering**: such a
  plugin will see narrowed results. Mitigation: set `selfFilters: true`
  on the slot. No such plugin exists in this repo today.
- **Contract redeploy** required: `llm-contracts` ships the `ArgSlot.selfFilters`
  field. Plugins that consume `ArgSlot` (kaizen-config, llm-slash-commands,
  and any future plugin) will recompile against the new contract.
- **Plugin redeploys**: `llm-slash-commands` and `kaizen-config` after the
  contract is in place.

## Out of scope

- Fuzzy / subsequence matching.
- Per-item `matchKey` field (would let value-tier rows opt back in to host
  filtering — adds CompletionItem surface area for marginal gain).
- Host-level (`llm-tui/completion/registry.ts`) post-filter for non-slash
  completion sources. Could add it later; today all completion sources flow
  through the two slash sources, both of which now filter correctly.
- Ranking results by match position or recency.
- Filtering on `detail`, type, or source.
