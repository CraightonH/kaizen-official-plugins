# Tool Approval — Argument-Aware Rules

**Status:** Design approved 2026-05-20
**Plugin:** `llm-tool-approval`
**Version target:** minor bump

## Problem

The approval gate (`plugins/llm-tool-approval`) currently matches rules on tool **name** only. A name-only allow rule auto-approves every invocation of that tool, ignoring its arguments. This is too coarse for tools whose risk depends on what they do, not just what they are:

- `bash` can run anything from `ls` to `rm -rf /`.
- `web_search` may fetch trusted hosts or arbitrary URLs.
- `glob`, `read`, `write`, `edit` may target safe paths or sensitive ones.

Today, allow-listing `bash` is all-or-nothing. There is no way to say "auto-approve `git status` but prompt for `rm`."

## Goals

1. Rules can restrict matching by argument content, not just tool name.
2. Existing name-only rules keep working unchanged (zero migration).
3. Syntax stays human-editable in JSON; no new contract or registry.
4. Safety override for `bash`: never auto-approve commands containing shell control characters that imply multiple commands or unparseable substructure — instead always prompt with a reason.

## Non-Goals

- Full shell parsing for `bash`. Quoted metacharacters are over-flagged on purpose.
- Per-tool projector code or contracts. The matcher discovers strings in `args` generically.
- Redirection (`>`, `>>`, `<`), brace expansion, env-var assignment prefixes as v1 safety triggers — revisit if they bite.
- Regex patterns in rules.

## Design

### 1. Rule grammar

Same JSON file shape (`{ "allow": string[], "deny": string[] }`). Each rule string gains an optional `(pattern)` suffix:

```
rule       := name                          # name-only — unchanged
            | name "(" pattern ")"          # arg-pattern rule
name       := <existing matcher: exact | "prefix:*" | "*">
pattern    := <shell-style glob; literal "(" / ")" not allowed in v1>
```

Pattern metacharacters: `*` (any chars including `/`), `?` (one char), `[abc]` (character class). No escapes in v1.

Parser:

- A rule containing `(` must end with `)`; everything between is the pattern.
- No nesting, no escapes.
- Malformed rules emit a `writeNotice` and are skipped at load. Never crash the gate.
- Patterns compile to `RegExp` once per rule per source load.

Example config:

```json
{
  "allow": [
    "read",
    "bash(git *)",
    "bash(ls *)",
    "web_search(*github.com/*)"
  ],
  "deny": [
    "bash(*sudo*)"
  ]
}
```

### 2. Match algorithm

Resolution order, evaluated per `tool:before-execute` call `(name, args)`:

```
1. If any deny rule matches:        cancel with rule-deny reason. Done.
2. If name === "bash":
     reason := bashSafety(args.command)
     If reason !== null:           force prompt; body shows reason; allow short-circuit is skipped.
3. If any allow rule matches:       approve. Done.
4. Otherwise:                       prompt with full options.
```

A `matchRule(name, args, rule)` helper:

1. Split rule into `(ruleName, rulePattern?)`.
2. Name check via existing `matches(name, ruleName)`. Fail → no match.
3. If no `rulePattern` → match.
4. Extract string leaves from `args` (§3). Empty set → no match.
5. If any leaf glob-matches `rulePattern` → match.

Notes:

- Deny is absolute. Bash safety does **not** override deny.
- Bash safety overrides allow only. A name-only allow rule (`"bash"` in `allow`) is also superseded by a safety hit.
- Domain rules (`mcp:github:*`) are name-only globs; they evaluate via step 2 of `matchRule` and never enter the pattern branch.

### 3. String-leaf extraction from `args`

```ts
function stringLeaves(args: unknown, max = 32): string[]
```

DFS collects every `string`-typed leaf. Non-string primitives skipped. `max` caps the total number of leaves returned (default 32) — once reached, traversal stops. Cycles tracked with a `WeakSet`; cyclic branches abort.

| `args` | leaves |
|---|---|
| `{ command: "ls -la" }` | `["ls -la"]` |
| `{ url: "https://github.com/x", headers: { ua: "x" } }` | `["https://github.com/x", "x"]` |
| `{ paths: ["/a", "/b"], depth: 2 }` | `["/a", "/b"]` |
| `"raw string arg"` | `["raw string arg"]` |
| `{ count: 5 }` | `[]` |

Semantics: **any leaf matches** the pattern → rule fires. For tools with multiple string fields this can produce false positives (auto-approval when only one of several strings matches). That is acceptable for an approval gate (a false-positive auto-approval is the only failure mode, and only within the rule's tool-name scope). Documented in README.

### 4. Bash safety detector

```ts
// bash-safety.ts — pure
export function bashSafety(command: unknown): string | null
```

Returns the first matching reason, or `null` if the command is clean. Non-string `command` returns `"non-string command"` (safer than passing through).

Triggers, in evaluation order:

| Check on `command` | Returned reason |
|---|---|
| contains `\n` or `\r` | `multiline command` |
| contains `` ` `` | `backtick command substitution — unable to inspect` |
| contains `$(` | `command substitution $(…) — unable to inspect` |
| contains `&&` or `\|\|` | `conditional chaining (&& / \|\|)` |
| contains `;` | `command separator ;` |
| contains `\|` (not `\|\|`) | `pipe \|` |
| matches `/&\s*$/` | `background execution &` |

Quoted occurrences are **not** exempted. `bash -c "echo 'ls; rm'"` flags. Correct shell-quote parsing is out of scope; over-flagging is the safer default.

### 5. Prompt UX

**Safety-flagged calls.** Body prepends one line; only `Approve Once` and `Deny` are offered:

```
⚠ bash safety: <reason>
<existing summary>
```

**Name-only matches (today's flow).** Unchanged. `Approve Always` persists the bare name. `Approve Domain Always` persists the derived `prefix:*`.

**Unmatched calls whose args produce string leaves.** Prompt offers an additional option, `Approve Pattern Always`, which opens a text input pre-filled with a derived suggestion:

- `bash` — first whitespace token + `*` (e.g. `git status` → `git *`).
- URL-shaped strings — `*<host>/*` (e.g. `https://github.com/x/y` → `*github.com/*`).
- Path-shaped strings — first two segments + `/*` (e.g. `/Users/chancock/foo` → `/Users/chancock/*`).
- Otherwise verbatim.

User can edit or clear the input. Empty submission falls back to `Approve Once` (no persist). Persisted as `tool(pattern)` to the same project/global target as today.

Option order in the prompt:

```
Approve Once          (bash: "ls -la")
Approve Always        (bash)
Approve Pattern Always (bash(git *))         ← only when args produce string leaves
Approve Domain Always (mcp:github:*)         ← only when name contains ":"
Deny
```

**Status item and slash commands.** Unchanged. `/approval:status` lists effective merged rules verbatim, including `tool(pattern)` strings.

### 6. Domain rules

Unchanged. `deriveDomain("mcp:github:list_issues") → "mcp:github:*"`. Domain rules are name-only globs and never enter the pattern branch. A rule like `mcp:github:*(some-pattern)` is grammatically valid (prefix-glob name + pattern), no special handling needed.

## Module map (delta)

```
matcher.ts        + parseRule(rule) → { name, pattern? } | null
                  + compilePattern(pattern) → RegExp
                  + matchRule(name, args, rule)
                  (existing matches/matchesAny/deriveDomain unchanged)
string-leaves.ts  (new) stringLeaves(args, max)
bash-safety.ts    (new) bashSafety(command)
subscriber.ts     resolution order updated; pattern-always option wired
defaults.json     unchanged
```

## Invariants (additions for CLAUDE.md)

- Deny is absolute. Bash safety overrides allow but not deny.
- Arg patterns are evaluated per-rule; never aggregated across rules.
- A safety-flagged prompt MUST NOT offer Approve Always or Approve Domain Always.

## Back-compat

- Existing configs parse identically. Grammar is a strict superset.
- `defaults.json` unchanged.
- Existing harness configs (e.g. `.kaizen/harnesses/official_openai-compatible/config.json`) unaffected.
- No public contract changes; `llm-tool-approval` exposes no `public.d.ts`. No `llm-contracts` churn.
- Plugin version: minor bump.

## Tests

Bun unit tests under `plugins/llm-tool-approval/test/`.

**`matcher.test.ts`** (extend)
- All existing name-only cases pass unchanged.
- `parseRule`: name-only, with pattern, malformed (`bash(ls`, `bash)`, `(pat)`).
- `compilePattern`: `*`, `?`, `[abc]`.
- `matchRule`: name + pattern hits on flat string, on nested string, no string leaves, name mismatch.

**`string-leaves.test.ts`** (new)
- Flat object, nested object, array, raw string, primitive-only args, cycle, depth/size cap.

**`bash-safety.test.ts`** (new)
- One test per trigger.
- Clean: `ls -la`, `git status`, `echo foo`, `python -m thing` → `null`.
- Non-string command → `non-string command`.
- First-match-wins order verified on multi-trigger inputs.

**`subscriber.test.ts`** (extend)
- Allow with pattern: matching args auto-approve; non-matching args prompt.
- Deny with pattern: matching args cancel without prompt.
- Bash safety overrides matching allow rule: prompt forced, options exclude Always / Domain Always.
- Bash safety does not override deny.
- Approve Pattern Always: persists `bash(<pattern>)` via `persistAllow`.
- Approve Pattern Always with empty text falls back to approve-once, no persist.

**`config.test.ts`** (extend)
- Round-trip load → merge → write of arg-pattern rules.
- Dedupe across sources; stable sort.

No integration test against a real harness. Existing test surface is unit-only and that's the right level.

## Migration

None. Users opt in by editing their own config.

## Documentation updates

`plugins/llm-tool-approval/README.md`:

- `tool(pattern)` syntax and glob metacharacters.
- Bash safety override + trigger list.
- "Any string leaf" matching semantics and the multi-string false-positive caveat.
- `Approve Pattern Always` option.

`plugins/llm-tool-approval/CLAUDE.md`:

- `bash-safety.ts` and `string-leaves.ts` added to module map.
- New invariants (deny absolute; safety overrides allow only; patterns per-rule).
