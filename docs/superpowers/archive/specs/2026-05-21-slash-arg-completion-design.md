# Slash-command argument completion — design

**Date:** 2026-05-21
**Scope:** `llm-contracts`, `llm-tui`, `llm-slash-commands`, `kaizen-config`

## Problem

Today, `/config:set <plugin> <key>=<value> [--project]` (and the sibling `/config:get`, `/config:unset`) requires the user to know:

- which plugins are registered with `config:store`,
- the exact keys each plugin declares in its schema,
- the legal value shapes for those keys (booleans, enums, secrets).

The TUI already has an inline completion popup (Up/Down/Tab/Enter) driven by `ui:completion-source`, but it only fires on the single-char `/` trigger to complete command names. After the space, the user is on their own.

This spec adds argument-aware completion: as the user types `/config:set ` the popup offers registered plugins; after picking one, the popup re-fires offering that plugin's keys (with type-aware value suggestions for booleans / enums); after the value, the popup offers `--project`. The same mechanism extends to `/config:get` and `/config:unset`.

## Goals

1. Popup-driven completion of plugin name, key (with value shortcuts for boolean and enum fields), and flags for `/config:set`, `/config:get`, `/config:unset`.
2. Generic, framework-level mechanism so any slash command can declare arguments and inherit popup completion — `kaizen-config` is the first consumer, not the only one.
3. Additive contract changes only: every existing `CompletionSource` and `SlashCommandManifest` consumer continues to compile and behave identically.

## Non-goals

- Dotted-path completion inside object/array fields. `/config:set foo bar.baz=qux` is typeable but the popup only offers top-level keys.
- Value completion for free-form string/number fields (no autosuggest from history).
- Wizard-style multi-prompt UX (rejected during brainstorm — would require new prompt plumbing through the dispatcher and re-entrancy rules).
- Filtering `/config:unset` suggestions by "keys currently set in scope." v1 offers all schema keys; unsetting an unset key is a no-op. May be revisited.

## Architecture

The work splits across four plugins. Two are contract-only; two add behavior.

### 1. `llm-contracts` — additive contract changes

**`contracts/ui-completion.ts`** gains an optional richer activation predicate alongside the existing single-char trigger. Exactly one of `trigger` / `match` is set per source.

```ts
export interface CompletionContext {
  line: string;
  cursor: number;
}

export interface CompletionSource {
  id: string;
  trigger?: string;                                  // existing char trigger
  match?: (line: string, cursor: number)             // new: predicate-based activation
    => { triggerPos: number; query: string } | null;
  list(query: string, ctx?: CompletionContext): CompletionItem[] | Promise<CompletionItem[]>;
}
```

`list()` receives the optional `ctx` so sources can peek at preceding tokens without re-parsing the popup state.

**`contracts/slash-registry.ts`** gains optional `arguments` and `flags` on the manifest:

```ts
export interface ArgSlot {
  name: string;
  description?: string;
  complete?: (prev: string[], query: string)
    => Promise<CompletionItem[]> | CompletionItem[];
}

export interface SlashCommandFlag {
  name: string;            // e.g. "--project"
  description?: string;
}

export interface SlashCommandManifest {
  // …existing fields…
  arguments?: ArgSlot[];
  flags?: SlashCommandFlag[];
}
```

Both extensions are additive — every existing consumer compiles unchanged.

### 2. `llm-tui` — match-based popup sessions

**`state/store.ts`** widens popup state:

```
popup: {
  sourceId: string;       // always set
  anchor: number;         // character index where the completed token starts
  trigger?: string;       // present only for char-triggered sources
  query: string;
  items: CompletionItem[];
}
```

Char-triggered popups set both `sourceId` and `trigger`; match-triggered popups set only `sourceId`.

**`ui/InputBox.tsx`** keypress handling adds a second pass after the existing trigger-char detection:

1. Run the existing trigger-char loop (preserves `/` behavior exactly).
2. If no popup is currently open: for each registered source that has a `match` predicate, call `match(line, cursor)`. First hit opens a popup pinned to that source's id at the returned `triggerPos` with the returned `query`.
3. If a match-triggered popup is currently open: re-evaluate that source's `match` against the new line/cursor. Null return closes; non-null updates `anchor` + `query`.

Cost: the second-pass `match` loop runs only over sources that *have* `match`. The slash plugin will register exactly one such source, so this is a single cheap predicate per keystroke.

**`completion/registry.ts`** gains `queryBySource(sourceId, q, ctx)` for the match-pinned path. The existing `query(trigger, q)` is unchanged. Debouncing, monotonic token cancellation, and per-source error swallowing apply to both.

Accept-popup behavior is unchanged: Enter/Tab on a selection inserts `insertText` and closes the popup. The user keeps typing.

### 3. `llm-slash-commands` — the generic arg-completion source

`index.ts` registers exactly one `CompletionSource` (id `llm-slash-commands:args`) with a `match` predicate:

1. **Parse the line** with the existing `parser.ts`. If the line doesn't parse as a slash command, return null.
2. **Look up the manifest** via `registry.get(name)`. If absent, or `manifest.arguments` empty/missing, return null.
3. **Tokenize args.** Split on whitespace, preserving the cursor position. Compute:
   - `slotIndex` — which positional slot the cursor is currently in (flags stripped).
   - `prevArgs` — positional tokens before the current slot.
   - `query` — partial token under the cursor (may be empty if cursor sits on whitespace).
   - `anchor` — character index where the current token starts.
4. If `slotIndex >= arguments.length`:
   - If `manifest.flags` is non-empty and there are flags not yet present in the line, treat this as a synthetic "flag slot" and return non-null with `query` = the partial token.
   - Otherwise return null.
5. If `arguments[slotIndex]?.complete` is absent (and we're not in the flag slot), return null.
6. Return `{ triggerPos: anchor, query }`.

`list(query, ctx)` re-runs steps 1–3 against the current line, then:

- For positional slots: calls `arguments[slotIndex].complete(prevArgs, query)`.
- For the synthetic flag slot: returns one `CompletionItem` per flag in `manifest.flags` that is not already present in the line.

**Re-entrancy.** Both `match` and `list` are pure reads against the registry and the line — no events emitted, no `ctx` touched. The existing `inSlashDispatch` guard is unaffected.

A new module `arg-completion.ts` holds this logic; `index.ts` wires it into the TUI's `ui:completion-source` registry alongside the existing command-name source. Both registrations are conditional on the service being present (consistent with the current optional dependency).

### 4. `kaizen-config` — slot declarations

`plugins/kaizen-config/slash.ts` gains `arguments` and `flags` on each of the three manifests. A new helper module `slash-completions.ts` (alongside `slash.ts`) holds the shared completion functions so `slash.ts` stays focused on handler wiring.

**`/config:set`** — slots: `[plugin, key=value]`; flags: `[--project]`.

- Slot 1 (`plugin`): one item per row from `store.list()`. `label` = plugin name; `insertText` = plugin name; `detail` summarizes resolution (`"home"`, `"project"`, `"home+project"`, or `"(unset)"`).
- Slot 2 (`key=value`): inspects `store.getSpec(prev[0])?.schema`. For each top-level key:
  - `type: "boolean"` → two items: `{label: "${key}=true", insertText: "${key}=true"}`, same for `false`.
  - `type: "enum"` → one item per value: `{label: "${key}=${v}", insertText: "${key}=${v}"}`.
  - `type: "string"` with `enum: [...]` → same as enum.
  - All other types → one item: `{label: key, insertText: "${key}="}`.
- `detail` carries the field type and a `· secret` suffix when `field.secret === true`.
- Object/array fields offer only the top-level key; dotted paths are out of scope for popup completion.

**`/config:get`** — slots: `[plugin, key]`; flags: `[--reveal]`.

- Slot 1 = same plugin source as above.
- Slot 2 = top-level keys from the plugin schema. Read-side, so no `=` suffix: `{label: key, insertText: key, detail: "${field.type}${secret ? " · secret" : ""}"}`.

**`/config:unset`** — slots: `[plugin, key]`; flags: `[--project]`.

- Slot 1 = same plugin source.
- Slot 2 = all top-level schema keys (v1). Refining to "currently-set in scope" is a follow-up.

## Data flow (worked example)

User types `/config:set ` (with trailing space).

1. `InputBox` keypress loop runs; existing `/` trigger does not re-fire (popup was closed when the user pressed space and the cursor moved past the `/`-anchored query).
2. Second pass: arg-completion source's `match` runs. Line parses as `name="config:set"`, `args=""`. Manifest has `arguments`, so `slotIndex=0`, `query=""`, `anchor=<position after the space>`. Returns non-null.
3. Popup opens pinned to `llm-slash-commands:args`. Registry calls `list("", ctx)`. Source re-parses → calls slot 0's `complete(prev=[], query="")` → returns one item per registered plugin.
4. User picks `kaizen-secrets-keychain`. `insertText` replaces the empty token at `anchor`. Popup closes. Line is now `/config:set kaizen-secrets-keychain`.
5. User types a space. Keypress loop fires; `match` re-evaluates. Now `slotIndex=1`, `prevArgs=["kaizen-secrets-keychain"]`, `query=""`. Returns non-null.
6. Popup re-opens. `list` calls slot 1's `complete(prev=["kaizen-secrets-keychain"], query="")` → fetches that plugin's schema → returns `backend=keychain`, `backend=env`, etc. (enum), plus a plain `defaultScheme=` item.
7. User picks `backend=keychain`. Line is now `/config:set kaizen-secrets-keychain backend=keychain`.
8. User types a space. `match` re-evaluates. `slotIndex=2` exceeds `arguments.length=2`; flags exist and `--project` isn't present. Returns non-null for the synthetic flag slot.
9. Popup offers `--project`. User accepts or presses Enter on no-match to submit.

## Error handling

- `match` and `list` swallow their own errors per the existing registry contract; a thrown error closes the popup silently rather than surfacing a notice.
- If `store.getSpec(plugin)` returns undefined (plugin not registered), slot 2 returns an empty list. The user can still type freely.
- Unknown flag tokens are ignored by tokenization for slot-index purposes (treated as positional). This may produce slightly stale popup contents if the user mistypes a flag, but does not break the popup.

## Testing

All `bun test` per plugin.

**`llm-contracts`** — `index.test.ts` already asserts `defineService` for each contract; no behavior change. Type-level: confirm `match` and `arguments`/`flags` compile as optional additions.

**`llm-tui`**

- `completion/registry.test.ts` — add: `queryBySource(id, q, ctx)` returns only the named source's items; cancellation token still cancels stale match-based queries; per-source error swallowing applies.
- `state/store.test.ts` — popup state now carries `sourceId` + optional `trigger`; existing snapshot assertions are updated.
- `ui/InputBox.test.tsx` — new fixtures: a fake source with a `match` predicate opens the popup at the expected anchor, query updates as the user types, popup closes when `match` returns null. Existing `/` trigger tests remain green.

**`llm-slash-commands`**

- New `arg-completion.test.ts` — parses representative lines, asserts `slotIndex` / `prevArgs` / `query` / `anchor` for cursor mid-token, cursor on whitespace, cursor after final positional, with and without flags interspersed; calls a fake manifest's `complete()` and asserts results.
- `integration.test.ts` — exercises the registered source end-to-end via the fake bus + a manifest with `arguments` and `flags`.

**`kaizen-config`**

- New `slash-completions.test.ts` — given a fake `ConfigStoreService` with three registered plugins (one with a boolean field, one with an enum field, one with a `secret: true` string), verifies popup items for each slot of each command. Specifically: boolean expands to `key=true`/`key=false`; enum expands one item per value; secret carries `· secret` in `detail`.

## Plugin-architecture acid test

Per `docs/PLUGIN_ARCHITECTURE.md`:

- **`defineService` location** — both extended contracts (`ui:completion-source`, `slash:registry`) are already defined in `llm-contracts`. No new `defineService` calls. Both extensions are type-only edits.
- **Contract IDs** — unchanged.
- **Provider swappability** — `ui:completion-source` has one provider (`llm-tui`); `slash:registry` has one provider (`llm-slash-commands`). Cardinality-one rule preserved.
- **Dependencies** — `kaizen-config` continues to consume `slash:registry` optionally; `llm-slash-commands` continues to consume `ui:completion-source` optionally. No new required edges.

## Local deploy order

1. `llm-contracts` first (contract type additions).
2. `llm-tui` and `llm-slash-commands` (behavioral changes — order between these doesn't matter, neither boots before contracts).
3. `kaizen-config` (manifest declarations).

Per repo CLAUDE.md: build each plugin's `dist/index.js` and rsync into the install dir.

## Open follow-ups (out of scope)

- `/config:unset` slot 2 filtering by "currently set in scope."
- Dotted-path completion for object/array fields.
- Value completion for free-form string fields from prior values / history.
