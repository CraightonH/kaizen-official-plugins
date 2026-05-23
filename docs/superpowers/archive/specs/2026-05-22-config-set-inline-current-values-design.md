# `/config:set` — inline current values in autocomplete

**Date:** 2026-05-22
**Plugin:** `kaizen-config`
**Status:** Design

## Problem

When a user runs `/config:set <plugin> ` and pulls up the autocomplete menu,
each row shows the field's type but never its current value. To answer "what's
the current value of `defaultSecretBackend`?" the user must abandon the
in-progress `set`, switch to `/config:get <plugin> defaultSecretBackend`,
re-walk the autocomplete path, then come back.

Worse, today's menu emits one row per boolean/enum value (`key=true`,
`key=false`, `key=keychain`, `key=bitwarden`, `key=env`, …). For a plugin with
several boolean fields, the menu is N×values rows of mostly redundant
information and still doesn't tell the user which value is current.

## Goals

1. Show the field's current effective value inline in the autocomplete menu.
2. Make booleans/enums one row per field at the top tier, with a second tier
   that surfaces value choices once the user has picked a field.
3. Pre-fill the current value into the buffer for free-form fields so the user
   can edit in place instead of re-typing.
4. Honour redaction and env-override precedence so the menu never silently
   misleads.

## Non-goals

- Adding a new contract surface (e.g. `store.describeField()`). The existing
  `ConfigStatus.resolution` map plus `store.get()`/`store.getSpec()` already
  carry everything we need.
- Changes outside `kaizen-config`. `llm-slash-commands` already passes
  `(prevArgs, query)` to the plugin's completion callback (`arg-completion.ts:99`)
  and `llm-tui` already re-evaluates match-based sources on every
  value/cursor change (`InputBox.tsx:165–185`).
- Replacing the redaction policy. The existing `redactValue` helper in
  `plugins/kaizen-config/secrets/redact.ts` is the single source of truth for
  secret rendering.

## Architecture

Single-plugin change to `kaizen-config`. One new pure module
`field-rendering.ts`, plus edits to `slash-completions.ts` and a one-line
wiring update in `slash.ts`.

```
slash.ts
   │ wires: complete: (prev, query) => keyEqualsValueCompletions(store, prev, query)
   ▼
slash-completions.ts
   │ orchestrator: branches on query (field tier vs value tier);
   │ pulls current values via store.get(), source map via store.list()
   ▼
field-rendering.ts          ← NEW pure module
   ├ renderFieldRow(...)    → CompletionItem      (field tier)
   └ renderValueRows(...)   → CompletionItem[]    (value tier)
```

`field-rendering.ts` has no dependency on `store`, `ctx`, or I/O. It takes
already-fetched data (schema, current value, resolution source) and returns
`CompletionItem`s. This isolation keeps the formatting rules unit-testable in
isolation from the store wiring.

## Components

### `field-rendering.ts` (new)

```ts
export type RenderInputs = {
  key: string;
  field: FieldSchema;
  currentValue: unknown;
  source: ConfigResolutionSource;   // "default" | "home" | "project" | "env" | "secret:..."
  isSet: boolean;                   // resolution source !== "default"
};

export function renderFieldRow(input: RenderInputs): CompletionItem;
export function renderValueRows(input: RenderInputs, valueQuery: string): CompletionItem[];
export function formatValue(
  value: unknown,
  field: FieldSchema,
  opts: { max: number },
): string;                          // exported for tests
```

`renderFieldRow` emits one row for a field. `renderValueRows` emits the
per-value rows for booleans/enums (and `[]` for free-form fields, since the
field row's pre-filled `insertText` already covers them).

"Enum-like" covers both `{ type: "enum", values: [...] }` and
`{ type: "string", enum: [...] }` — `renderValueRows` treats them identically,
matching the existing logic in `keyEqualsValueCompletions`. "Free-form" means
any `string` without an `enum`, plus `number`.

`formatValue` redacts secrets to `***`, JSON-stringifies non-scalars, and
truncates the result to `opts.max` characters with a trailing `…`. The truncated
form is used only for the `detail` string — the full value is preserved in
`insertText`.

### `slash-completions.ts`

```ts
export async function keyEqualsValueCompletions(
  store: ConfigStoreService,
  prev: string[],
  query: string,                  // NEW
): Promise<CompletionItem[]> {
  const plugin = prev[0];
  if (!plugin) return [];
  const spec = store.getSpec(plugin);
  if (!spec?.schema) return [];

  const merged = store.get(plugin) as Record<string, unknown>;
  const status = store.list().find((r) => r.plugin === plugin);
  const resolution = status?.resolution ?? {};

  const eqIdx = query.indexOf("=");
  if (eqIdx === -1) {
    // Field tier
    return Object.entries(spec.schema).flatMap(([key, field]) =>
      field
        ? [renderFieldRow({
            key,
            field,
            currentValue: merged[key],
            source: resolution[key] ?? "default",
            isSet: resolution[key] !== "default",
          })]
        : []);
  }
  // Value tier
  const key = query.slice(0, eqIdx);
  const valueQuery = query.slice(eqIdx + 1);
  const field = spec.schema[key];
  if (!field) return [];
  return renderValueRows(
    {
      key,
      field,
      currentValue: merged[key],
      source: resolution[key] ?? "default",
      isSet: resolution[key] !== "default",
    },
    valueQuery,
  );
}
```

`keyOnlyCompletions` (consumed by `/config:get` and `/config:unset`) gets the
same `✓ <value> · <source>  <type>` detail treatment via `renderFieldRow`.
No value tier is needed for those commands since they don't take a value.

### `slash.ts`

One-line change in the `/config:set` `register` call to thread `query`
through to `keyEqualsValueCompletions`:

```ts
{ name: "key=value", complete: (prev, query) => keyEqualsValueCompletions(deps.store, prev, query) }
```

The `/config:get` and `/config:unset` registrations continue to use
`keyOnlyCompletions`, whose existing single-tier behavior doesn't need the
`query` argument. Both inherit the new `[<value> · <source>] <type>` detail
treatment because `keyOnlyCompletions` is updated to call `renderFieldRow`
internally.

## Data flow

1. User types `/config:set llm-tui `. Cursor lands past the trailing space.
2. `llm-tui`'s `InputBox` re-evaluates match-based completion sources
   (`InputBox.tsx:165–185`).
3. `llm-slash-commands`' `arg-completion.ts` tokenizes the args region, finds
   the active positional slot index `1`, sets `query=""`, and calls
   `arguments[1].complete(prevArgs=["llm-tui"], query="")`.
4. `keyEqualsValueCompletions` sees no `=` in `query` → field tier. It pulls
   the schema (`store.getSpec`), the merged value snapshot (`store.get`), and
   the per-field resolution map (`store.list().find(...).resolution`). For
   each field it calls `renderFieldRow`.
5. User picks `thoughtsMarkdown` (detail: `✓ true · home  boolean`). The
   accepted row's `insertText` is `thoughtsMarkdown=`. The cursor now sits
   right after `=`.
6. Steps 2–3 fire again. `query` is now `"thoughtsMarkdown="`.
7. `keyEqualsValueCompletions` sees `=` → value tier. It slices the query at
   `=`, looks up the field schema for `thoughtsMarkdown`, and calls
   `renderValueRows`. The result is two rows:
   `✓ true` / `boolean` (insertText `thoughtsMarkdown=true `) and
   `  false` / `boolean` (insertText `thoughtsMarkdown=false `).
8. User picks one. `insertText` includes a trailing space, which advances the
   slot index past `1` and triggers the flag-tier menu (`--project`).

## Rendering rules

### Common convention: the `✓` glyph

Wherever the menu surfaces "this is the value currently in force," the
rendered text is prefixed with `✓ ` (U+2713 followed by a single space).
Non-current rows in the same menu get a `  ` (two-space) prefix so the
value column stays vertically aligned.

This applies to:

- Field-tier `detail` (the field's effective value).
- Value-tier `label` (each value choice, with `✓` only on the one matching
  the current value).

The "unset" state shows `(unset)` with no `✓` — nothing is in force.

### Field tier (query has no `=`)

`label` is always the bare field key (e.g. `defaultSecretBackend`). The
table below shows the `detail` and `insertText`.

| Scenario | `detail` | `insertText` |
|---|---|---|
| Free-form string/number, set in `home` | `✓ bitwarden · home  string` | `defaultSecretBackend=bitwarden ` |
| Free-form, only default | `✓ bitwarden · default  string` | `defaultSecretBackend=bitwarden ` |
| Free-form, env override active | `✓ bitwarden · env  string` | `defaultSecretBackend=` |
| Secret string, set | `✓ *** · home  string · secret` | `apiKey=` |
| Secret string, unset | `(unset)  string · secret` | `apiKey=` |
| Boolean, set | `✓ true · home  boolean` | `thoughtsMarkdown=` |
| Enum, set | `✓ keychain · project  enum` | `defaultSecretBackend=` |
| Unset (no default) | `(unset)  string` | `key=` |
| Value length > 30 | `✓ abcdefghij…vwxyz · home  string` | full value in insertText |

`default` is shown explicitly in the detail (the user opted in to surfacing
defaults so it's clear *why* the field has its current effective value).

### Value tier (query like `key=` or `key=part`)

`label` carries the value with the `✓`/`  ` prefix; `detail` is the type
only. `insertText` is always the full `key=value ` token so the slash arg
parses correctly.

| Scenario | Rows (`label` / `detail` / `insertText`) |
|---|---|
| Boolean, current `true` | `✓ true` / `boolean` / `thoughtsMarkdown=true `<br>`  false` / `boolean` / `thoughtsMarkdown=false ` |
| Enum `keychain\|bitwarden\|env`, current `bitwarden` | `  keychain` / `enum` / `defaultSecretBackend=keychain `<br>`✓ bitwarden` / `enum` / `defaultSecretBackend=bitwarden `<br>`  env` / `enum` / `defaultSecretBackend=env ` |
| `valueQuery = "k"` | only rows whose value starts with `k` |
| Free-form string/number | `[]` |

The `✓` directly answers "what's set now?" while the un-checked rows show
the values you'd be selecting in place of it.

## `insertText` pre-fill rules

Pre-fill the current value (i.e. `insertText: \`${key}=${value} \``) **only**
when ALL of the following hold:

- Field type is free-form (`string` without `enum`, or `number`).
- Field is not secret.
- Resolution source is not `env` (would silently allow a shadowed file write).
- `isSet` is true (something other than `default` is in force).
- Stringified value contains no whitespace and does not start with `--`
  (would tokenize wrong in the slash arg parser).

In any other case, `insertText` is `\`${key}=\``.

## Error handling

- Plugin not registered → `keyEqualsValueCompletions` returns `[]` (current
  behavior preserved via the `getSpec()` guard).
- Field name in `query` not in schema → empty list. The user typed a key that
  doesn't exist; there are no valid value suggestions to offer.
- `store.get()` returning malformed data (shouldn't happen given schema
  validation invariants, but defensively): `formatValue` catches and renders
  `(error)` so the menu degrades gracefully.
- `redactValue` throwing on a non-conformant secret value: same fall-through
  to `(error)`.

## Testing

- **`field-rendering.test.ts`** (new): one `describe` per scenario in the
  field-tier and value-tier tables. Pure functions; tests construct
  `RenderInputs` directly and assert on `CompletionItem` shape. Covers each
  source value, each field type, secrets, unset, env, truncation, and
  pre-fill suppression rules.
- **`slash-completions.test.ts`**: add tier-branching tests
  (`query === ""` → field tier, `query.includes("=")` → value tier,
  `query === "key=k"` → filter applied). Keep existing assertion shape for
  the field-tier rows; the row count drops from N×values to N for
  boolean/enum fields, so update the boolean/enum assertions.
- **`slash.test.ts`**: smoke-test the wiring change (the callback now receives
  `query` and propagates it).
- No new integration tests. The cross-plugin path
  (`llm-tui` → `llm-slash-commands` → `kaizen-config`) is already exercised
  by existing harness boot tests and doesn't change behavior — only the
  payload of `CompletionItem.detail` and `insertText` differs.

## Risks and mitigations

- **Menu visual width.** Long `detail` strings can wrap. Truncation at 30
  chars on the value portion keeps the typical row to ~60 chars including
  source marker and type. Will adjust based on usage.
- **Pre-fill surprises.** A pre-filled `defaultSecretBackend=bitwarden ` in
  the buffer is destructive if the user then types without first selecting
  the value. Mitigated by: pre-fill only for free-form types where the alternative
  (typing from scratch) is the larger cost; clear opt-out for secrets, env
  overrides, and values with awkward characters.
- **Performance.** `store.get()` and `store.list()` are in-memory operations
  and run once per completion call. No measurable overhead expected.
- **Tier confusion.** A user typing `key=` manually (without going through
  the field tier) still gets the value tier menu — the branching is purely
  syntactic on `query`. This is the intended behavior, not a bug.

## Open questions

None at time of writing. Truncation length (30), the default marker
(shown explicitly rather than elided), and the `✓` convention (unified
across field and value tiers) were locked during brainstorming.
