# Filter completion menus by in-progress query

## Problem

The `/config:*` slash commands have three completion menus that ignore the
token the user is currently typing:

- **Plugin tier** (`pluginCompletions`) — drops the query entirely; always
  returns every registered plugin.
- **Key tier** (`keyOnlyCompletions` for `/config:get` / `/config:unset`,
  and the pre-`=` branch of `keyEqualsValueCompletions` for `/config:set`) —
  drops the query; always returns every schema field.
- **Value tier** (post-`=` branch of `keyEqualsValueCompletions`, via
  `renderValueRows`) — does filter, but with `startsWith` (prefix, case-sensitive),
  which is inconsistent with what we want elsewhere and surprises users typing
  fragments.

The host already passes the in-progress token to each `complete(prev, query)`
callback (see `llm-contracts/contracts/slash-registry.ts`). It does not do
client-side filtering for us. Each completion function must apply the filter
itself.

## Goal

Every completion menu narrows as the user types, using the same rule.

## Design

### Match rule

Case-insensitive **substring** match against `CompletionItem.label`.

- Substring (not prefix): typing `key` should find `apiKey`.
- Case-insensitive: identifier menus are small and the user shouldn't pay
  attention to case.
- `label` only — not `detail`. Detail strings include type names, source
  labels (`home`, `project`, `env`), `(unset)`, etc. Matching on those would
  surprise users (typing `string` would filter to all string-typed fields).
- Empty / whitespace-only query is a no-op (return everything).

Fuzzy / subsequence matching is explicitly out of scope. The lists are small
enough that substring is sufficient, and substring is trivial to test
deterministically.

### Shared helper

A single helper, exported from `slash-completions.ts`:

```ts
export function filterByQuery(items: CompletionItem[], query: string): CompletionItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => item.label.toLowerCase().includes(q));
}
```

Applied at the tail of each completion function. The internal logic of each
function (resolution detail, ✓ markers, insertText pre-fill) is untouched —
filtering is purely a final pass over already-rendered rows.

### Wiring

`slash-completions.ts`:

1. **`pluginCompletions`** — add a `query: string` parameter. Build the
   rows as today, then `return filterByQuery(rows, query)`.
2. **`keyOnlyCompletions`** — add a `query: string` parameter. Apply
   `filterByQuery` at the end.
3. **`keyEqualsValueCompletions`** — already takes `query`. In the
   `eqIdx === -1` (key tier) branch, apply `filterByQuery(rows, query)`
   before returning. The value-tier branch keeps using `valueQuery` for its
   own filtering — see next item.

`field-rendering.ts`:

4. **`renderValueRows`** — replace the two `startsWith(valueQuery)` calls
   with the same case-insensitive substring rule (inline, or delegate to a
   tiny `matchesQuery(haystack, query)` helper sharing the same lowercase
   logic). This keeps value-tier behavior consistent with the rest.

`slash.ts`:

5. Pass `query` through to `pluginCompletions` and `keyOnlyCompletions` at
   each `complete:` callsite (the registry already supplies it as the second
   argument to the callback).

### What does not change

- The contract surface (`llm-contracts/contracts/slash-registry.ts`,
  `ui-completion.ts`). No new types, no new fields.
- `CompletionItem` shape and the `detail` / `insertText` conventions —
  filtering is orthogonal to rendering.
- The `✓ value · source  type` detail format and the field-tier
  pre-fill rules from the inline-current-values work.
- Plugin manifests, JSON schemas, atomic writes — nothing on the store side.

## Testing

Add cases to `plugins/kaizen-config/slash-completions.test.ts`:

- `pluginCompletions` with query `"kai"` returns only `kaizen-config`; empty
  query returns both rows.
- `keyOnlyCompletions` with query `"key"` returns only `apiKey`; case
  insensitivity: query `"KEY"` returns the same.
- `keyEqualsValueCompletions` key tier: query `"back"` returns only
  `backend`; query `""` returns all four fields (regression of existing
  behavior).
- `keyEqualsValueCompletions` value tier: switch the existing
  `"value tier: filters by post-= text"` case from prefix to substring —
  e.g. query `"backend=ch"` should match `keychain`.
- A unit test for `filterByQuery` itself covering: empty query no-op,
  case-insensitivity, substring (not just prefix), and label-only (a row
  whose detail contains the query but label does not should be filtered out).

Existing tests that assert the full unfiltered list (e.g. "field tier
(empty query): one row per field") stay green because empty query is a
no-op.

## Risk / migration

- **Behavior change for value tier**: prefix → substring. Possible surprise
  for anyone who memorized that `backend=k` returned only `keychain`; under
  the new rule it still does (substring of `keychain` starting with `k`).
  Substring is strictly more permissive than prefix, so any prior result
  set is a subset of the new one. No silent breakage.
- **No contract change**, so no `llm-contracts` redeploy needed.
- **Local deploy**: standard kaizen-config rebuild + redeploy. No dependent
  plugins.

## Out of scope

- Fuzzy / subsequence matching.
- Ranking results by match position or recency.
- Filtering on `detail`, type, or source.
- Any change to the host harness (it already passes `query`).
