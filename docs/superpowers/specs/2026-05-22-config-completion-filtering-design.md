# Filter every completion menu by in-progress query

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

The host completion registry (`llm-tui/completion/registry.ts`) does NOT
post-filter merged source results — it trusts each source. So the fix lives
in each source.

## Goal

Every completion menu in the harness uses the same filtering rule:
**case-insensitive substring of the in-progress token against the item's
`label`**. Empty query is a no-op (full list).

## Why substring, not prefix or fuzzy

- Prefix breaks `key` → `apiKey`. Real menu, real keystrokes.
- Substring catches that case and is still deterministic, cheap, and trivial
  to test.
- Fuzzy / subsequence (`apK` → `apiKey`) adds ranking concerns the menus
  don't need at their size. Out of scope.

## Why label-only

Items carry a `detail` field that includes type names, source labels
(`home`, `project`, `env`), `(unset)`, command descriptions, etc.
Matching on those would surprise users (typing `string` would filter
fields by type; typing `home` would only show home-resolved fields).
The user types what they see on the left of each row — that's `label`.

## Why per-callsite, not host-level

Routing all filtering through `llm-tui/completion/registry.ts` would
collapse the rule to one place, but it can't handle the value tier
without a contract change. There, the slot query is `backend=k` while
the rendered label is `✓ keychain` — the host has no way to split the
`key=value` form. A `CompletionSource.selfFilters: true` opt-out would
work, but adds a contract field for marginal gain across six callsites.
Keeping the filter at each source is six small edits and zero new types.

## Changes

### `llm-slash-commands/completion.ts`

Replace the prefix filter on slash-command names with substring + case-fold.

```diff
-      .filter((m) => m.name.startsWith(query))
+      .filter((m) => matchesQuery(m.name, query))
```

The sort order (built-in first, then file, then plugin-namespaced; alpha
within rank) is preserved.

### `llm-slash-commands/arg-completion.ts`

The flag-slot branch returns one item per declared flag not yet present in
the line. Filter that list by the slot query:

```diff
       return flags
         .filter((f) => !present.has(f.name))
+        .filter((f) => matchesQuery(f.name, slot.query))
         .map<CompletionItem>((f) => ({ ... }));
```

The positional branch already delegates to the plugin's
`fn(slot.prevArgs, slot.query)` — no change here; the plugin decides.

### `kaizen-config/slash-completions.ts`

Three small changes:

1. **`pluginCompletions`** — add a `query: string` parameter (default `""`
   for backwards-call-compat in tests). Build the rows as today, return
   `filterByQuery(rows, query)`.
2. **`keyOnlyCompletions`** — add a `query: string` parameter. Apply
   `filterByQuery` at the end.
3. **`keyEqualsValueCompletions`** — already takes `query`. In the
   `eqIdx === -1` (key tier) branch, apply `filterByQuery(rows, query)`
   before returning. The value tier branch already receives the post-`=`
   substring and renders via `renderValueRows` — see next change.

### `kaizen-config/field-rendering.ts`

`renderValueRows` switches from prefix to substring + case-fold for the two
filter sites:

```diff
-      .filter((v) => v.startsWith(valueQuery))
+      .filter((v) => matchesQuery(v, valueQuery))
```

### `kaizen-config/slash.ts`

Thread the slot query into the two completion callbacks that newly accept
it:

```diff
-      { name: "plugin", complete: () => pluginCompletions(deps.store) },
-      { name: "key",    complete: (prev) => keyOnlyCompletions(deps.store, prev) },
+      { name: "plugin", complete: (_p, q) => pluginCompletions(deps.store, q) },
+      { name: "key",    complete: (prev, q) => keyOnlyCompletions(deps.store, prev, q) },
```

(All three `complete:` callsites for `/config:get`, `/config:set`,
`/config:unset` get the same treatment for the plugin/key slots.)

### Shared helper

Each plugin gets its own tiny helper (rather than a shared one — the
`llm-contracts` plugin is types-only and adding a new utility plugin for
two five-line functions isn't worth it):

```ts
// In both llm-slash-commands/completion.ts (or a local util) and
// kaizen-config/slash-completions.ts:
export function matchesQuery(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystack.toLowerCase().includes(q);
}

export function filterByQuery<T extends { label: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => item.label.toLowerCase().includes(q));
}
```

Duplicating ten lines is cheaper than the cross-plugin coupling needed to
share them. If a third plugin grows its own completion source later and
wants the same rule, lift the helper into a shared module then.

### What does not change

- Contract surface (`llm-contracts/contracts/slash-registry.ts`,
  `ui-completion.ts`). No new fields, no `selfFilters` opt-out, no new
  service.
- The `✓ value · source  type` detail format and field-tier pre-fill
  rules from the prior inline-current-values work.
- The completion registry coalescing, debounce, async cancellation, and
  per-source error swallowing.
- `CompletionItem` shape; sort order across all menus.

## Testing

### `plugins/llm-slash-commands/test/completion.test.ts` (or sibling file)

- Substring match: registering `/config:get`, `/config:set`, `/help`,
  filter by `"conf"` returns both `/config:*` entries.
- Case fold: filter by `"CONFIG"` returns the same set.
- Empty query: returns all entries.
- Sort order preserved across the filtered subset.

### `plugins/llm-slash-commands/test/arg-completion.test.ts`

- Flag list: with two flags `--project` and `--reveal` declared and slot
  query `"pro"`, returns only `--project`.
- Empty slot query: returns both.
- Case fold on flag names.

### `plugins/kaizen-config/slash-completions.test.ts`

- `pluginCompletions` with query `"kai"` returns only `kaizen-config`;
  empty query returns both rows; existing trailing-space test stays green.
- `keyOnlyCompletions` with query `"key"` returns only `apiKey`; query
  `"KEY"` returns the same.
- `keyEqualsValueCompletions` key tier: query `"back"` returns only
  `backend`; empty query returns all four fields (existing test stays
  green).
- `keyEqualsValueCompletions` value tier: rename the existing prefix
  test to substring — query `"backend=ch"` matches `keychain`.
- Tests for `filterByQuery` and `matchesQuery` themselves: empty query
  no-op, case-insensitivity, substring (not just prefix), label-only
  (`filterByQuery` ignores `detail`).

Existing tests that assert the full unfiltered list (e.g. `field tier
(empty query)`) stay green because empty query is a no-op.

## Risk and migration

- **Behavior change on three menus that previously didn't filter**
  (plugin tier, key tier, flag list): they now narrow as you type. Pure
  improvement.
- **Behavior change on two menus that did filter via prefix**
  (slash-name, value tier): prefix → substring. Substring is strictly
  more permissive than prefix, so any prior match is still a match. No
  silent breakage.
- **Case sensitivity loss**: previously `/Config` did not match
  `/config:*`; now it does. Slash names are lowercase by validator
  (parser regex anchors to `[a-z]`), so this only matters during typing,
  where it's the expected behavior.
- **No contract change**, so no `llm-contracts` redeploy is needed.
- Local deploy: rebuild + redeploy `llm-slash-commands` and
  `kaizen-config` per their CLAUDE.md recipes. No dependent plugins
  beyond those two.

## Out of scope

- Fuzzy / subsequence matching.
- Ranking results by match position or recency.
- Filtering on `detail`, type, or source.
- Centralized host-side filtering in `llm-tui/completion/registry.ts`
  (requires a contract opt-out for the value tier; deferred).
- Any change to how the popup itself renders, debounces, or sorts.
