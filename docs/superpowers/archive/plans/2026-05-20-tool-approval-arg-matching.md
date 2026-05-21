# Tool Approval — Argument-Aware Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `llm-tool-approval` plugin so allow/deny rules can be conditional on tool arguments, and add a hard-prompt safety override for `bash` commands containing shell control characters.

**Architecture:** Three new pure modules (`string-leaves.ts`, `bash-safety.ts`, `suggest-pattern.ts`) plus `parseRule` / `compilePattern` / `matchRule` / `matchesAnyRule` additions to `matcher.ts`. The subscriber's resolution order becomes `deny → bash-safety → allow → prompt`. The prompt gains an `Approve Pattern Always` option that captures `tool(pattern)` rules into project config. No new contract, no plugin-author burden, fully back-compat — name-only rules in existing configs continue to behave identically.

**Tech Stack:** TypeScript, Bun test runner, `llm-contracts` (consumed), `llm-events` (`CANCEL_TOOL`). Pure-function modules, dependency-injected subscriber.

**Spec:** `docs/superpowers/specs/2026-05-20-tool-approval-arg-matching-design.md`

---

## File Structure

**Create:**
- `plugins/llm-tool-approval/string-leaves.ts` — pure DFS string-leaf extractor.
- `plugins/llm-tool-approval/bash-safety.ts` — pure bash-command safety detector.
- `plugins/llm-tool-approval/suggest-pattern.ts` — pure pattern suggestion for "Approve Pattern Always".
- `plugins/llm-tool-approval/test/string-leaves.test.ts`
- `plugins/llm-tool-approval/test/bash-safety.test.ts`
- `plugins/llm-tool-approval/test/suggest-pattern.test.ts`

**Modify:**
- `plugins/llm-tool-approval/matcher.ts` — add `parseRule`, `compilePattern`, `matchRule`, `matchesAnyRule`. Keep existing exports for back-compat.
- `plugins/llm-tool-approval/subscriber.ts` — new resolution order, `Approve Pattern Always` option, safety-flagged prompt body.
- `plugins/llm-tool-approval/test/matcher.test.ts` — extend.
- `plugins/llm-tool-approval/test/subscriber.test.ts` — extend.
- `plugins/llm-tool-approval/CLAUDE.md` — module map, invariants.
- `plugins/llm-tool-approval/README.md` — config syntax, bash safety, Approve Pattern Always, multi-string caveat.
- `plugins/llm-tool-approval/package.json` — version bump `0.1.1` → `0.2.0`.

`defaults.json` is unchanged. `index.ts` is unchanged (subscriber wiring through `makeSubscriber` already accepts everything the new logic needs).

---

## Task 1: String-leaf extractor

**Files:**
- Create: `plugins/llm-tool-approval/string-leaves.ts`
- Test: `plugins/llm-tool-approval/test/string-leaves.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-tool-approval/test/string-leaves.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { stringLeaves } from "../string-leaves.ts";

describe("stringLeaves", () => {
  it("returns a single string for a flat object", () => {
    expect(stringLeaves({ command: "ls -la" })).toEqual(["ls -la"]);
  });

  it("collects nested strings in objects and arrays", () => {
    expect(
      stringLeaves({ url: "https://github.com/x", headers: { ua: "x" }, paths: ["/a", "/b"] }),
    ).toEqual(["https://github.com/x", "x", "/a", "/b"]);
  });

  it("returns [] when args has no string leaves", () => {
    expect(stringLeaves({ count: 5, enabled: true, n: null })).toEqual([]);
  });

  it("handles a raw string arg", () => {
    expect(stringLeaves("raw string arg")).toEqual(["raw string arg"]);
  });

  it("ignores non-string primitives at any depth", () => {
    expect(stringLeaves({ a: 1, b: { c: "yes", d: false } })).toEqual(["yes"]);
  });

  it("caps total leaves at the supplied max", () => {
    const big = { items: Array.from({ length: 100 }, (_, i) => `s${i}`) };
    const out = stringLeaves(big, 5);
    expect(out).toEqual(["s0", "s1", "s2", "s3", "s4"]);
  });

  it("does not loop forever on cyclic input", () => {
    const a: any = { name: "a" };
    a.self = a;
    const out = stringLeaves(a);
    expect(out).toEqual(["a"]);
  });

  it("returns [] for null / undefined / non-object primitives", () => {
    expect(stringLeaves(null)).toEqual([]);
    expect(stringLeaves(undefined)).toEqual([]);
    expect(stringLeaves(42)).toEqual([]);
    expect(stringLeaves(true)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd plugins/llm-tool-approval && bun test test/string-leaves.test.ts
```

Expected: FAIL — module `../string-leaves.ts` not found.

- [ ] **Step 3: Implement `stringLeaves`**

`plugins/llm-tool-approval/string-leaves.ts`:

```ts
/**
 * Depth-first collect every string-typed leaf in `args`. Non-string primitives
 * are skipped. Cycles abort their branch. Stops once `max` leaves are
 * collected (default 32).
 */
export function stringLeaves(args: unknown, max = 32): string[] {
  const out: string[] = [];
  const seen = new WeakSet<object>();

  const visit = (v: unknown): void => {
    if (out.length >= max) return;
    if (typeof v === "string") {
      out.push(v);
      return;
    }
    if (v === null || typeof v !== "object") return;
    if (seen.has(v as object)) return;
    seen.add(v as object);
    if (Array.isArray(v)) {
      for (const item of v) {
        if (out.length >= max) return;
        visit(item);
      }
      return;
    }
    for (const val of Object.values(v as Record<string, unknown>)) {
      if (out.length >= max) return;
      visit(val);
    }
  };

  visit(args);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

```sh
cd plugins/llm-tool-approval && bun test test/string-leaves.test.ts
```

Expected: PASS — 8 tests pass.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-tool-approval/string-leaves.ts plugins/llm-tool-approval/test/string-leaves.test.ts
git commit -m "llm-tool-approval: add stringLeaves helper"
```

---

## Task 2: Bash safety detector

**Files:**
- Create: `plugins/llm-tool-approval/bash-safety.ts`
- Test: `plugins/llm-tool-approval/test/bash-safety.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-tool-approval/test/bash-safety.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { bashSafety } from "../bash-safety.ts";

describe("bashSafety", () => {
  it("returns null for a clean simple command", () => {
    expect(bashSafety("ls -la")).toBeNull();
    expect(bashSafety("git status")).toBeNull();
    expect(bashSafety("echo foo")).toBeNull();
    expect(bashSafety("python -m thing --flag=v")).toBeNull();
  });

  it("flags non-string command", () => {
    expect(bashSafety(undefined)).toBe("non-string command");
    expect(bashSafety(null)).toBe("non-string command");
    expect(bashSafety(42)).toBe("non-string command");
    expect(bashSafety("")).toBe("non-string command");
  });

  it("flags multiline commands first", () => {
    expect(bashSafety("ls\nrm -rf /")).toBe("multiline command");
    expect(bashSafety("ls\r\necho x")).toBe("multiline command");
  });

  it("flags backtick substitution", () => {
    expect(bashSafety("echo `whoami`")).toBe(
      "backtick command substitution — unable to inspect",
    );
  });

  it("flags $(...) substitution", () => {
    expect(bashSafety("echo $(whoami)")).toBe(
      "command substitution $(…) — unable to inspect",
    );
  });

  it("flags conditional chaining && and ||", () => {
    expect(bashSafety("ls && echo ok")).toBe("conditional chaining (&& / ||)");
    expect(bashSafety("ls || echo nope")).toBe("conditional chaining (&& / ||)");
  });

  it("flags command separator ;", () => {
    expect(bashSafety("ls; echo done")).toBe("command separator ;");
  });

  it("flags a plain pipe but not ||", () => {
    expect(bashSafety("ls | grep foo")).toBe("pipe |");
  });

  it("flags trailing & (background)", () => {
    expect(bashSafety("sleep 5 &")).toBe("background execution &");
    expect(bashSafety("sleep 5 & ")).toBe("background execution &");
  });

  it("does not flag & that is part of && (already covered by chaining reason)", () => {
    expect(bashSafety("ls && echo ok")).toBe("conditional chaining (&& / ||)");
  });

  it("flags quoted metacharacters too (over-flagging is the safer default)", () => {
    expect(bashSafety("bash -c 'ls; rm'")).toBe("command separator ;");
  });

  it("first match wins in declared order — newline beats backtick", () => {
    expect(bashSafety("ls\n`x`")).toBe("multiline command");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd plugins/llm-tool-approval && bun test test/bash-safety.test.ts
```

Expected: FAIL — module `../bash-safety.ts` not found.

- [ ] **Step 3: Implement `bashSafety`**

`plugins/llm-tool-approval/bash-safety.ts`:

```ts
/**
 * Inspects a bash `command` string for shell control characters that imply
 * multiple commands or unparseable structure. Returns the first matching
 * reason, or `null` if the command appears to be a single simple command.
 *
 * Checks are intentionally string-level — quoted metacharacters are NOT
 * exempted. Over-flagging is the safer default for an approval gate.
 */
export function bashSafety(command: unknown): string | null {
  if (typeof command !== "string" || command.length === 0) {
    return "non-string command";
  }
  if (command.includes("\n") || command.includes("\r")) {
    return "multiline command";
  }
  if (command.includes("`")) {
    return "backtick command substitution — unable to inspect";
  }
  if (command.includes("$(")) {
    return "command substitution $(…) — unable to inspect";
  }
  if (command.includes("&&") || command.includes("||")) {
    return "conditional chaining (&& / ||)";
  }
  if (command.includes(";")) {
    return "command separator ;";
  }
  if (containsPipe(command)) {
    return "pipe |";
  }
  if (/&\s*$/.test(command)) {
    return "background execution &";
  }
  return null;
}

// `&&` and `||` are handled before this; here we look for any `|` that is not
// part of `||`.
function containsPipe(command: string): boolean {
  for (let i = 0; i < command.length; i++) {
    if (command[i] !== "|") continue;
    const next = command[i + 1];
    const prev = command[i - 1];
    if (next === "|" || prev === "|") continue;
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

```sh
cd plugins/llm-tool-approval && bun test test/bash-safety.test.ts
```

Expected: PASS — all bashSafety tests pass.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-tool-approval/bash-safety.ts plugins/llm-tool-approval/test/bash-safety.test.ts
git commit -m "llm-tool-approval: add bashSafety detector"
```

---

## Task 3: Rule parser and pattern compiler

**Files:**
- Modify: `plugins/llm-tool-approval/matcher.ts`
- Test: `plugins/llm-tool-approval/test/matcher.test.ts`

- [ ] **Step 1: Write the failing test (extend existing file)**

Append to `plugins/llm-tool-approval/test/matcher.test.ts`:

```ts
import { parseRule, compilePattern } from "../matcher.ts";

describe("parseRule", () => {
  it("returns name-only for rules with no parentheses", () => {
    expect(parseRule("fs:read_file")).toEqual({ name: "fs:read_file" });
    expect(parseRule("mcp:github:*")).toEqual({ name: "mcp:github:*" });
    expect(parseRule("*")).toEqual({ name: "*" });
  });

  it("splits name and pattern when parentheses are present", () => {
    expect(parseRule("bash(ls *)")).toEqual({ name: "bash", pattern: "ls *" });
    expect(parseRule("web_search(*github.com/*)")).toEqual({
      name: "web_search",
      pattern: "*github.com/*",
    });
  });

  it("allows prefix-glob names with patterns", () => {
    expect(parseRule("mcp:github:*(foo)")).toEqual({
      name: "mcp:github:*",
      pattern: "foo",
    });
  });

  it("returns null for malformed rules", () => {
    expect(parseRule("bash(ls")).toBeNull();   // unclosed
    expect(parseRule("bash)")).toBeNull();     // close without open
    expect(parseRule("(pat)")).toBeNull();     // empty name
    expect(parseRule("bash()")).toBeNull();    // empty pattern
    expect(parseRule("bash(a)b")).toBeNull();  // trailing junk after )
  });

  it("ignores empty / non-string input", () => {
    expect(parseRule("")).toBeNull();
    expect(parseRule(undefined as unknown as string)).toBeNull();
  });
});

describe("compilePattern", () => {
  it("compiles literal patterns to anchored regex", () => {
    const re = compilePattern("ls");
    expect(re.test("ls")).toBe(true);
    expect(re.test("ls -la")).toBe(false);
  });

  it("translates * to any-character sequence (including /)", () => {
    const re = compilePattern("ls *");
    expect(re.test("ls -la")).toBe(true);
    expect(re.test("ls /tmp/a/b")).toBe(true);
    expect(re.test("rm -rf /")).toBe(false);
  });

  it("translates ? to one character", () => {
    const re = compilePattern("a?c");
    expect(re.test("abc")).toBe(true);
    expect(re.test("ac")).toBe(false);
    expect(re.test("abbc")).toBe(false);
  });

  it("supports character classes", () => {
    const re = compilePattern("[abc]oo");
    expect(re.test("aoo")).toBe(true);
    expect(re.test("doo")).toBe(false);
  });

  it("escapes regex metacharacters in the source pattern", () => {
    const re = compilePattern("a.b+c");
    expect(re.test("a.b+c")).toBe(true);
    expect(re.test("axbxxc")).toBe(false);
  });

  it("anchors the match", () => {
    const re = compilePattern("foo");
    expect(re.test("xfoox")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd plugins/llm-tool-approval && bun test test/matcher.test.ts
```

Expected: FAIL — `parseRule` / `compilePattern` not exported.

- [ ] **Step 3: Add `parseRule` and `compilePattern` to `matcher.ts`**

Append to `plugins/llm-tool-approval/matcher.ts` (do not remove existing exports):

```ts
export interface ParsedRule {
  name: string;
  pattern?: string;
}

/**
 * Splits a rule string into its name part and optional argument-pattern part.
 *
 *   "read"                       → { name: "read" }
 *   "bash(ls *)"                 → { name: "bash", pattern: "ls *" }
 *   "mcp:github:*(foo)"          → { name: "mcp:github:*", pattern: "foo" }
 *
 * Malformed rules return `null` — the caller should skip them and emit a
 * notice. v1 disallows `(` or `)` inside the pattern (no escapes, no nesting).
 */
export function parseRule(rule: string): ParsedRule | null {
  if (typeof rule !== "string" || rule.length === 0) return null;
  const open = rule.indexOf("(");
  if (open < 0) {
    if (rule.includes(")")) return null;
    return { name: rule };
  }
  if (open === 0) return null; // empty name
  if (!rule.endsWith(")")) return null; // trailing junk after pattern close
  const name = rule.slice(0, open);
  const pattern = rule.slice(open + 1, -1);
  if (pattern.length === 0) return null;
  if (pattern.includes("(") || pattern.includes(")")) return null;
  return { name, pattern };
}

/**
 * Compiles a shell-style glob pattern to an anchored RegExp.
 * Supported metacharacters: `*`, `?`, `[abc]`. All other regex metacharacters
 * are escaped. v1 does not support escapes.
 */
export function compilePattern(pattern: string): RegExp {
  let src = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      src += ".*";
    } else if (ch === "?") {
      src += ".";
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close < 0) {
        // Unclosed class — treat the rest as literal.
        src += escapeRegex(pattern.slice(i));
        i = pattern.length;
      } else {
        src += "[" + pattern.slice(i + 1, close) + "]";
        i = close;
      }
    } else {
      src += escapeRegex(ch);
    }
  }
  src += "$";
  return new RegExp(src);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 4: Run test to verify it passes**

```sh
cd plugins/llm-tool-approval && bun test test/matcher.test.ts
```

Expected: PASS — original matcher tests still pass; new `parseRule` and `compilePattern` tests pass.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-tool-approval/matcher.ts plugins/llm-tool-approval/test/matcher.test.ts
git commit -m "llm-tool-approval: parseRule + compilePattern in matcher"
```

---

## Task 4: `matchRule` and `matchesAnyRule`

**Files:**
- Modify: `plugins/llm-tool-approval/matcher.ts`
- Test: `plugins/llm-tool-approval/test/matcher.test.ts`

- [ ] **Step 1: Write the failing test (extend existing file)**

Append to `plugins/llm-tool-approval/test/matcher.test.ts`:

```ts
import { matchRule, matchesAnyRule } from "../matcher.ts";

describe("matchRule (name-only rules)", () => {
  it("falls back to name match when rule has no pattern", () => {
    expect(matchRule("fs:read_file", {}, "fs:read_file")).toBe(true);
    expect(matchRule("fs:read_file", {}, "fs:*")).toBe(true);
    expect(matchRule("fs:write_file", {}, "fs:read_file")).toBe(false);
  });

  it("ignores args when rule has no pattern", () => {
    expect(matchRule("bash", { command: "rm -rf /" }, "bash")).toBe(true);
  });
});

describe("matchRule (arg patterns)", () => {
  it("matches when a string leaf glob-matches the pattern", () => {
    expect(matchRule("bash", { command: "ls -la" }, "bash(ls *)")).toBe(true);
    expect(matchRule("bash", { command: "git status" }, "bash(git *)")).toBe(true);
  });

  it("does not match when no string leaf matches", () => {
    expect(matchRule("bash", { command: "rm -rf /" }, "bash(ls *)")).toBe(false);
  });

  it("does not match when name differs", () => {
    expect(matchRule("read", { command: "ls" }, "bash(ls *)")).toBe(false);
  });

  it("returns false when args have no string leaves", () => {
    expect(matchRule("bash", { count: 5 }, "bash(ls *)")).toBe(false);
  });

  it("matches nested string leaves", () => {
    expect(
      matchRule("web_search", { params: { url: "https://github.com/x" } }, "web_search(*github.com/*)"),
    ).toBe(true);
  });

  it("skips malformed rules silently (returns false)", () => {
    expect(matchRule("bash", { command: "ls" }, "bash(ls")).toBe(false);
  });
});

describe("matchesAnyRule", () => {
  it("returns true on first matching rule", () => {
    expect(
      matchesAnyRule("bash", { command: "ls -la" }, ["bash(rm *)", "bash(ls *)"]),
    ).toBe(true);
  });

  it("returns false when no rule matches", () => {
    expect(matchesAnyRule("bash", { command: "ls -la" }, ["bash(rm *)"])).toBe(false);
  });

  it("returns false on empty rule list", () => {
    expect(matchesAnyRule("bash", { command: "ls" }, [])).toBe(false);
  });

  it("mixes name-only and pattern rules in one list", () => {
    expect(
      matchesAnyRule("bash", { command: "rm -rf /" }, ["read", "bash(ls *)", "bash"]),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd plugins/llm-tool-approval && bun test test/matcher.test.ts
```

Expected: FAIL — `matchRule` / `matchesAnyRule` not exported.

- [ ] **Step 3: Implement `matchRule` and `matchesAnyRule`**

Append to `plugins/llm-tool-approval/matcher.ts`:

```ts
import { stringLeaves } from "./string-leaves.ts";

/**
 * True iff the given tool call (`name`, `args`) matches `rule`.
 *
 * Name-only rules behave exactly like `matches()`. Argument-pattern rules
 * additionally require at least one string leaf in `args` to glob-match the
 * pattern. Malformed rules return false silently — callers warn at load time.
 */
export function matchRule(name: string, args: unknown, rule: string): boolean {
  const parsed = parseRule(rule);
  if (!parsed) return false;
  if (!matches(name, parsed.name)) return false;
  if (parsed.pattern === undefined) return true;
  const re = compilePattern(parsed.pattern);
  const leaves = stringLeaves(args);
  for (const leaf of leaves) {
    if (re.test(leaf)) return true;
  }
  return false;
}

export function matchesAnyRule(
  name: string,
  args: unknown,
  rules: ReadonlyArray<string>,
): boolean {
  for (const r of rules) {
    if (matchRule(name, args, r)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

```sh
cd plugins/llm-tool-approval && bun test test/matcher.test.ts
```

Expected: PASS — all matcher tests pass (original + parser + matchRule).

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-tool-approval/matcher.ts plugins/llm-tool-approval/test/matcher.test.ts
git commit -m "llm-tool-approval: matchRule + matchesAnyRule with arg patterns"
```

---

## Task 5: Pattern suggestion helper

**Files:**
- Create: `plugins/llm-tool-approval/suggest-pattern.ts`
- Test: `plugins/llm-tool-approval/test/suggest-pattern.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-tool-approval/test/suggest-pattern.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { suggestPattern } from "../suggest-pattern.ts";

describe("suggestPattern", () => {
  it("returns null when args have no string leaves", () => {
    expect(suggestPattern("bash", { count: 5 })).toBeNull();
  });

  it("for bash, uses first whitespace token + *", () => {
    expect(suggestPattern("bash", { command: "git status" })).toBe("git *");
    expect(suggestPattern("bash", { command: "ls -la /tmp" })).toBe("ls *");
    expect(suggestPattern("bash", { command: "echo" })).toBe("echo *");
  });

  it("for URL-shaped strings, suggests *<host>/*", () => {
    expect(suggestPattern("web_search", { url: "https://github.com/x/y" })).toBe(
      "*github.com/*",
    );
    expect(suggestPattern("web_fetch", { url: "http://api.example.com/v1/items" })).toBe(
      "*api.example.com/*",
    );
  });

  it("for path-shaped strings, suggests first-two-segments + /*", () => {
    expect(suggestPattern("read", { path: "/Users/chancock/foo/bar" })).toBe(
      "/Users/chancock/*",
    );
    expect(suggestPattern("glob", { pattern: "/etc/nginx/conf.d/*.conf" })).toBe(
      "/etc/nginx/*",
    );
  });

  it("for a short path with only one segment, suggests path + /*", () => {
    expect(suggestPattern("read", { path: "/tmp" })).toBe("/tmp/*");
  });

  it("for unrecognized strings, suggests the verbatim leaf", () => {
    expect(suggestPattern("axiom_record", { event: "click" })).toBe("click");
  });

  it("picks the longest leaf when multiple are present", () => {
    expect(
      suggestPattern("custom", { a: "short", b: "https://github.com/a/b/c" }),
    ).toBe("*github.com/*");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd plugins/llm-tool-approval && bun test test/suggest-pattern.test.ts
```

Expected: FAIL — module `../suggest-pattern.ts` not found.

- [ ] **Step 3: Implement `suggestPattern`**

`plugins/llm-tool-approval/suggest-pattern.ts`:

```ts
import { stringLeaves } from "./string-leaves.ts";

/**
 * Produces a sensible default pattern for the "Approve Pattern Always" prompt
 * option. The user can edit or clear it before submitting.
 *
 *   bash + "git status"                    → "git *"
 *   web_search + "https://github.com/x/y"  → "*github.com/*"
 *   read + "/Users/chancock/foo/bar"       → "/Users/chancock/*"
 *
 * Returns null when args have no string leaves (option should be hidden).
 */
export function suggestPattern(name: string, args: unknown): string | null {
  const leaves = stringLeaves(args);
  if (leaves.length === 0) return null;

  if (name === "bash") {
    const cmd = leaves[0]!;
    const firstTok = cmd.split(/\s+/)[0] ?? cmd;
    return `${firstTok} *`;
  }

  const leaf = leaves.reduce((longest, s) => (s.length > longest.length ? s : longest), leaves[0]!);

  const urlHost = extractHost(leaf);
  if (urlHost) return `*${urlHost}/*`;

  if (leaf.startsWith("/") || leaf.startsWith("~/")) {
    return collapseTwoSegments(leaf);
  }

  return leaf;
}

function extractHost(s: string): string | null {
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
  return m ? m[1]! : null;
}

function collapseTwoSegments(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  if (parts.length <= 2) return `${trimmed}/*`;
  return `${parts.slice(0, 3).join("/")}/*`;
}
```

- [ ] **Step 4: Run test to verify it passes**

```sh
cd plugins/llm-tool-approval && bun test test/suggest-pattern.test.ts
```

Expected: PASS — all suggestPattern tests pass.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-tool-approval/suggest-pattern.ts plugins/llm-tool-approval/test/suggest-pattern.test.ts
git commit -m "llm-tool-approval: add suggestPattern helper"
```

---

## Task 6: Subscriber — wire deny/allow to `matchesAnyRule`

This task is a pure refactor: switch the existing deny/allow short-circuits over to the new `matchesAnyRule` helper. No behavior change yet; sets up Tasks 7–8.

**Files:**
- Modify: `plugins/llm-tool-approval/subscriber.ts`

- [ ] **Step 1: Run the existing subscriber tests as a baseline**

```sh
cd plugins/llm-tool-approval && bun test test/subscriber.test.ts
```

Expected: PASS — current behavior intact.

- [ ] **Step 2: Switch subscriber to `matchesAnyRule`**

In `plugins/llm-tool-approval/subscriber.ts`, change the import line:

```ts
import { deriveDomain, matchesAny } from "./matcher.ts";
```

to:

```ts
import { deriveDomain, matchesAnyRule } from "./matcher.ts";
```

Replace the deny block:

```ts
    if (matchesAny(payload.name, deny)) {
```

with:

```ts
    if (matchesAnyRule(payload.name, payload.args, deny)) {
```

Replace the allow block:

```ts
    if (matchesAny(payload.name, allow)) {
      return;
    }
```

with:

```ts
    if (matchesAnyRule(payload.name, payload.args, allow)) {
      return;
    }
```

- [ ] **Step 3: Run subscriber tests to verify behavior is unchanged**

```sh
cd plugins/llm-tool-approval && bun test test/subscriber.test.ts
```

Expected: PASS — every existing test still passes (name-only rules behave identically under the new helper).

- [ ] **Step 4: Run the full plugin test suite**

```sh
cd plugins/llm-tool-approval && bun test
```

Expected: PASS — all suites.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-tool-approval/subscriber.ts
git commit -m "llm-tool-approval: route subscriber through matchesAnyRule"
```

---

## Task 7: Subscriber — bash safety override

**Files:**
- Modify: `plugins/llm-tool-approval/subscriber.ts`
- Test: `plugins/llm-tool-approval/test/subscriber.test.ts`

- [ ] **Step 1: Write the failing tests (append to existing file)**

Append to `plugins/llm-tool-approval/test/subscriber.test.ts`:

```ts
describe("subscriber — bash safety override", () => {
  it("force-prompts when bash command has shell metacharacters even if name-allow rule would approve", async () => {
    let captured: any = null;
    const promptSpy = mock(async (req: any) => { captured = req; return { id: "approve-once" }; });
    const sub = makeSubscriber(makeDeps({
      rules: () => ({ allow: ["bash"], deny: [] }),
      prompt: { requestOption: promptSpy, requestText: async () => "" },
    }));
    const p = mkPayload({ name: "bash", args: { command: "ls; rm -rf /" } });
    await sub(p);
    expect(promptSpy).toHaveBeenCalled();
    expect(captured.body).toContain("⚠ bash safety: command separator ;");
    const ids = captured.options.map((o: any) => o.id);
    expect(ids).toEqual(["approve-once", "deny"]);
  });

  it("force-prompts when bash command has shell metacharacters even if pattern-allow rule would approve", async () => {
    let captured: any = null;
    const sub = makeSubscriber(makeDeps({
      rules: () => ({ allow: ["bash(ls *)"], deny: [] }),
      prompt: {
        requestOption: async (req) => { captured = req; return { id: "approve-once" }; },
        requestText: async () => "",
      },
    }));
    await sub(mkPayload({ name: "bash", args: { command: "ls; rm -rf /" } }));
    expect(captured.body).toContain("⚠ bash safety:");
  });

  it("does NOT override deny — denied bash calls stay denied without prompt", async () => {
    const promptSpy = mock(async () => ({ id: "approve-once" as const }));
    const sub = makeSubscriber(makeDeps({
      rules: () => ({ allow: [], deny: ["bash"] }),
      prompt: { requestOption: promptSpy, requestText: async () => "" },
    }));
    const p = mkPayload({ name: "bash", args: { command: "ls; rm" } });
    await sub(p);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(p.args).toBe(CANCEL_TOOL);
  });

  it("does NOT override allow for clean bash commands", async () => {
    const promptSpy = mock(async () => ({ id: "approve-once" as const }));
    const sub = makeSubscriber(makeDeps({
      rules: () => ({ allow: ["bash(ls *)"], deny: [] }),
      prompt: { requestOption: promptSpy, requestText: async () => "" },
    }));
    const p = mkPayload({ name: "bash", args: { command: "ls -la" } });
    await sub(p);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(p.args).toEqual({ command: "ls -la" });
  });

  it("safety override hides Approve Always and Approve Domain Always", async () => {
    let captured: any = null;
    const sub = makeSubscriber(makeDeps({
      rules: () => ({ allow: [], deny: [] }),
      prompt: {
        requestOption: async (req) => { captured = req; return { id: "approve-once" }; },
        requestText: async () => "",
      },
    }));
    await sub(mkPayload({ name: "bash", args: { command: "echo `whoami`" } }));
    const ids = captured.options.map((o: any) => o.id);
    expect(ids).not.toContain("approve-always");
    expect(ids).not.toContain("approve-domain-always");
    expect(ids).not.toContain("approve-pattern-always");
    expect(ids).toEqual(["approve-once", "deny"]);
  });
});
```

- [ ] **Step 2: Run subscriber tests to verify they fail**

```sh
cd plugins/llm-tool-approval && bun test test/subscriber.test.ts
```

Expected: FAIL — bash-safety override not implemented; existing tests still pass.

- [ ] **Step 3: Implement bash safety override in `subscriber.ts`**

Add this import at the top:

```ts
import { bashSafety } from "./bash-safety.ts";
```

Replace the body of `makeSubscriber` between the deny check and the prompt construction with the version below. The deny short-circuit stays first; safety override sits between deny and allow:

```ts
    if (matchesAnyRule(payload.name, payload.args, deny)) {
      payload.args = CANCEL_TOOL;
      payload.cancelReason = DENY_BY_RULE_REASON;
      deps.writeNotice(`✗ approval gate: ${payload.name} denied by rule`);
      return;
    }

    let safetyReason: string | null = null;
    if (payload.name === "bash") {
      const cmd = (payload.args as { command?: unknown } | undefined)?.command;
      safetyReason = bashSafety(cmd);
    }

    if (!safetyReason && matchesAnyRule(payload.name, payload.args, allow)) {
      return;
    }
```

Then update the prompt-options construction so that when `safetyReason` is set, only `approve-once` and `deny` are offered, and the body is prefixed with the safety line:

```ts
    const domain = deriveDomain(payload.name);
    const body = safetyReason
      ? `⚠ bash safety: ${safetyReason}\n${deps.summarize(payload.name, payload.args)}`
      : deps.summarize(payload.name, payload.args);

    const options: UiPromptOptionsRequest["options"] = safetyReason
      ? [
          { id: "approve-once", label: `Approve Once          (${payload.name})` },
          {
            id: "deny",
            label: `Deny`,
            expandsTo: { kind: "text" as const, placeholder: "Reason (optional)" },
          },
        ]
      : [
          { id: "approve-once", label: `Approve Once          (${payload.name})` },
          { id: "approve-always", label: `Approve Always        (${payload.name})` },
          ...(domain
            ? [{ id: "approve-domain-always", label: `Approve Domain Always (${domain})` }]
            : []),
          {
            id: "deny",
            label: `Deny`,
            expandsTo: { kind: "text" as const, placeholder: "Reason (optional)" },
          },
        ];
    const req: UiPromptOptionsRequest = {
      title: "Approve tool call?",
      body,
      options,
      defaultId: "approve-once",
      cancelId: "deny",
    };
```

(Leave the rest of the function — the `switch (result.id)` block — unchanged for now. Task 8 extends it.)

- [ ] **Step 4: Run subscriber tests to verify they pass**

```sh
cd plugins/llm-tool-approval && bun test test/subscriber.test.ts
```

Expected: PASS — all subscriber tests pass (existing + new bash-safety tests).

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-tool-approval/subscriber.ts plugins/llm-tool-approval/test/subscriber.test.ts
git commit -m "llm-tool-approval: bash safety override forces prompt"
```

---

## Task 8: Subscriber — Approve Pattern Always option

**Files:**
- Modify: `plugins/llm-tool-approval/subscriber.ts`
- Test: `plugins/llm-tool-approval/test/subscriber.test.ts`

- [ ] **Step 1: Write the failing tests (append to existing file)**

Append to `plugins/llm-tool-approval/test/subscriber.test.ts`:

```ts
describe("subscriber — Approve Pattern Always", () => {
  it("includes the option with a suggested pattern when args have string leaves", async () => {
    let captured: any = null;
    const sub = makeSubscriber(makeDeps({
      prompt: {
        requestOption: async (req) => { captured = req; return { id: "approve-once" }; },
        requestText: async () => "",
      },
    }));
    await sub(mkPayload({ name: "bash", args: { command: "git status" } }));
    const opt = captured.options.find((o: any) => o.id === "approve-pattern-always");
    expect(opt).toBeDefined();
    expect(opt.label).toContain("bash(git *)");
    expect(opt.expandsTo).toEqual({
      kind: "text",
      placeholder: "Pattern (edit or clear to approve once)",
      defaultValue: "git *",
    });
  });

  it("omits the option when args produce no string leaves", async () => {
    let captured: any = null;
    const sub = makeSubscriber(makeDeps({
      prompt: {
        requestOption: async (req) => { captured = req; return { id: "approve-once" }; },
        requestText: async () => "",
      },
    }));
    await sub(mkPayload({ name: "axiom_record", args: { n: 5 } }));
    const ids = captured.options.map((o: any) => o.id);
    expect(ids).not.toContain("approve-pattern-always");
  });

  it("persists tool(pattern) when user submits a pattern", async () => {
    const persisted: string[] = [];
    const sub = makeSubscriber(makeDeps({
      prompt: {
        requestOption: async () => ({ id: "approve-pattern-always", text: "git *" }),
        requestText: async () => "",
      },
      persistAllow: (entry) => { persisted.push(entry); },
    }));
    const p = mkPayload({ name: "bash", args: { command: "git status" } });
    await sub(p);
    expect(persisted).toEqual(["bash(git *)"]);
    expect(p.args).toEqual({ command: "git status" });
  });

  it("falls back to approve-once when the user clears the input", async () => {
    const persisted: string[] = [];
    const sub = makeSubscriber(makeDeps({
      prompt: {
        requestOption: async () => ({ id: "approve-pattern-always", text: "" }),
        requestText: async () => "",
      },
      persistAllow: (entry) => { persisted.push(entry); },
    }));
    const p = mkPayload({ name: "bash", args: { command: "git status" } });
    await sub(p);
    expect(persisted).toEqual([]);
    expect(p.args).toEqual({ command: "git status" });
  });

  it("falls back to approve-once when whitespace-only text is submitted", async () => {
    const persisted: string[] = [];
    const sub = makeSubscriber(makeDeps({
      prompt: {
        requestOption: async () => ({ id: "approve-pattern-always", text: "   " }),
        requestText: async () => "",
      },
      persistAllow: (entry) => { persisted.push(entry); },
    }));
    await sub(mkPayload({ name: "bash", args: { command: "git status" } }));
    expect(persisted).toEqual([]);
  });

  it("safety-flagged calls do not offer the pattern option", async () => {
    let captured: any = null;
    const sub = makeSubscriber(makeDeps({
      prompt: {
        requestOption: async (req) => { captured = req; return { id: "approve-once" }; },
        requestText: async () => "",
      },
    }));
    await sub(mkPayload({ name: "bash", args: { command: "ls; rm" } }));
    const ids = captured.options.map((o: any) => o.id);
    expect(ids).not.toContain("approve-pattern-always");
  });
});
```

- [ ] **Step 2: Run subscriber tests to verify they fail**

```sh
cd plugins/llm-tool-approval && bun test test/subscriber.test.ts
```

Expected: FAIL — option not yet rendered or handled.

- [ ] **Step 3: Wire `Approve Pattern Always` into the prompt and the switch**

In `plugins/llm-tool-approval/subscriber.ts`, add the import:

```ts
import { suggestPattern } from "./suggest-pattern.ts";
```

Compute the suggestion in the non-safety branch and inject the option **before** the deny entry:

```ts
    const domain = deriveDomain(payload.name);
    const body = safetyReason
      ? `⚠ bash safety: ${safetyReason}\n${deps.summarize(payload.name, payload.args)}`
      : deps.summarize(payload.name, payload.args);

    const suggestion = safetyReason ? null : suggestPattern(payload.name, payload.args);

    const denyOption = {
      id: "deny" as const,
      label: `Deny`,
      expandsTo: { kind: "text" as const, placeholder: "Reason (optional)" },
    };

    const options: UiPromptOptionsRequest["options"] = safetyReason
      ? [
          { id: "approve-once", label: `Approve Once          (${payload.name})` },
          denyOption,
        ]
      : [
          { id: "approve-once", label: `Approve Once          (${payload.name})` },
          { id: "approve-always", label: `Approve Always        (${payload.name})` },
          ...(suggestion
            ? [{
                id: "approve-pattern-always",
                label: `Approve Pattern Always (${payload.name}(${suggestion}))`,
                expandsTo: {
                  kind: "text" as const,
                  placeholder: "Pattern (edit or clear to approve once)",
                  defaultValue: suggestion,
                },
              }]
            : []),
          ...(domain
            ? [{ id: "approve-domain-always", label: `Approve Domain Always (${domain})` }]
            : []),
          denyOption,
        ];
```

Extend the `switch (result.id)` block. Add a new case **before** the `case "deny"`:

```ts
      case "approve-pattern-always": {
        const raw = (result.text ?? "").trim();
        if (raw.length === 0) {
          return; // user cleared → approve-once
        }
        await tryPersist(deps, `${payload.name}(${raw})`);
        return;
      }
```

- [ ] **Step 4: Run subscriber tests to verify they pass**

```sh
cd plugins/llm-tool-approval && bun test test/subscriber.test.ts
```

Expected: PASS — all subscriber tests pass.

- [ ] **Step 5: Run the full plugin test suite**

```sh
cd plugins/llm-tool-approval && bun test
```

Expected: PASS — all suites (`index.test.ts`, `matcher.test.ts`, `slash.test.ts`, `subscriber.test.ts`, `string-leaves.test.ts`, `bash-safety.test.ts`, `suggest-pattern.test.ts`).

- [ ] **Step 6: Commit**

```sh
git add plugins/llm-tool-approval/subscriber.ts plugins/llm-tool-approval/test/subscriber.test.ts
git commit -m "llm-tool-approval: Approve Pattern Always option"
```

---

## Task 9: Plugin validate + version bump + docs

**Files:**
- Modify: `plugins/llm-tool-approval/package.json`
- Modify: `plugins/llm-tool-approval/README.md`
- Modify: `plugins/llm-tool-approval/CLAUDE.md`

- [ ] **Step 1: Run `kaizen plugin validate` to make sure manifest still passes**

```sh
kaizen plugin validate plugins/llm-tool-approval
```

Expected: PASS — no manifest or structural errors.

- [ ] **Step 2: Bump the version**

Edit `plugins/llm-tool-approval/package.json` and change:

```json
  "version": "0.1.1",
```

to:

```json
  "version": "0.2.0",
```

- [ ] **Step 3: Extend `README.md`**

Replace the current `### Match semantics` section in `plugins/llm-tool-approval/README.md` with:

````markdown
### Match semantics

- Exact tool name (`fs:read_file`).
- Prefix glob (`mcp:github:*`, `fs:*`, or catch-all `*`). `*` is valid only as a trailing segment after `:`, or alone.
- Argument pattern (`tool(pattern)`). The rule fires when the tool name matches **and** at least one string-typed leaf in the call's `args` glob-matches the pattern. Supported pattern metacharacters: `*` (any chars including `/`), `?` (one char), `[abc]` (character class). No escapes in v1.
- Resolution order: `deny → bash-safety → allow → prompt`. Deny is absolute. A bash-safety hit forces a prompt and overrides `allow` (but not `deny`).

`tool(pattern)` matches against **any** string leaf in `args`. For tools with multiple string fields this can over-match (rule fires when only one of several strings matches the pattern); this is acceptable for an approval gate where the failure mode is an unnecessary auto-approval within the tool-name scope.

### Bash safety

`bash` commands containing shell control characters are never auto-approved — the gate forces a prompt and shows the reason. Triggers (first match reported):

| Detected in `args.command` | Reason |
|---|---|
| `\n` or `\r` | multiline command |
| `` ` `` | backtick command substitution — unable to inspect |
| `$(` | command substitution `$(…)` — unable to inspect |
| `&&` or `\|\|` | conditional chaining (`&&` / `\|\|`) |
| `;` | command separator `;` |
| `\|` (plain pipe, not `\|\|`) | pipe `\|` |
| trailing `&` | background execution `&` |

Quoted occurrences are **not** exempted — `bash -c "echo 'ls; rm'"` flags. Over-flagging is the safer default. Safety-flagged prompts only offer **Approve Once** and **Deny**; the "always"-flavored options are hidden because no sensible rule could persist a chained command.
````

Add a new section after `### Domain derivation`:

````markdown
### Approve Pattern Always

When the call has string-typed args and no rule has matched, the prompt offers an extra option, **Approve Pattern Always**, with a suggested pattern derived from the call (e.g. `bash git status` → `git *`, `web_search https://github.com/x/y` → `*github.com/*`, `read /Users/chancock/foo` → `/Users/chancock/*`). The user can edit or clear the suggestion. Submitting an empty pattern falls back to **Approve Once** (no persist). Submitting a non-empty pattern persists `tool(pattern)` to the same project/global config target as the other "always" options.
````

- [ ] **Step 4: Extend `CLAUDE.md`**

Update the module map in `plugins/llm-tool-approval/CLAUDE.md`. Replace the existing module map block with:

```
index.ts             Plugin lifecycle. Reads services, wires the subscriber + slash + status item.
                     Only file that touches `ctx`.
matcher.ts           Pure: domain derivation + match logic. Existing name-only matchers
                     (matches / matchesAny / deriveDomain) + parseRule / compilePattern /
                     matchRule / matchesAnyRule for argument-aware rules.
string-leaves.ts     Pure: DFS extractor for string-typed leaves in tool args.
bash-safety.ts       Pure: detects shell control characters in a bash command string.
                     First-match-wins; over-flags quoted metacharacters on purpose.
suggest-pattern.ts   Pure: derives a default pattern for "Approve Pattern Always"
                     (bash → first token + *, URL → *host/*, path → first two segments + /*).
config.ts            Pure functions + small fs surface. Loads three sources, picks write target,
                     atomic write, dedupe + sort.
subscriber.ts        Pure handler. DI for ui:prompt, matcher, config, channel/notice helpers.
                     Implements deny → bash-safety → allow → prompt; renders the
                     Approve Pattern Always option.
slash.ts             Three slash commands. Pure aside from the slash-registry registration call.
defaults.json        Shipped baseline allow-list.
```

Extend the `## Invariants` section by appending these bullets after the existing ones:

```
- **Deny is absolute.** Bash safety overrides `allow` but never `deny`.
- **Bash safety override only applies to `name === "bash"`** and inspects `args.command`. Other tools are unaffected.
- **Safety-flagged prompts hide Always / Domain Always / Pattern Always options.** A chained or unparseable command cannot be sensibly persisted as a future allow rule.
- **Arg patterns are evaluated per-rule, never aggregated across rules.** Two pattern rules in `allow` do not combine — each must independently match its own pattern against some string leaf.
- **Pattern matching is "any string leaf matches".** Pattern rules over-match for multi-string args; documented in README.
```

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-tool-approval/package.json plugins/llm-tool-approval/README.md plugins/llm-tool-approval/CLAUDE.md
git commit -m "llm-tool-approval: v0.2.0 — README + CLAUDE.md for arg-aware rules"
```

---

## Task 10: Bundle and local deploy

This plugin is consumed via the kaizen plugin install dir (see plugin `CLAUDE.md` "Local deploy"). Build the bundle and stage it so the next harness run picks up the new behavior.

**Files:**
- Modify: `plugins/llm-tool-approval/dist/index.js` (generated)
- Stages to: `~/.kaizen/marketplaces/official/plugins/llm-tool-approval@0.2.0/`

- [ ] **Step 1: Bundle**

```sh
cd plugins/llm-tool-approval && bun build --target=bun --outfile=dist/index.js index.ts
```

Expected: build succeeds; `dist/index.js` updated.

- [ ] **Step 2: Stage to the local install dir**

Run from the repo root:

```sh
PLUGIN=llm-tool-approval
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
echo "staged to $INSTALL_DIR"
```

Expected: directory exists and contains `dist/index.js` plus source.

- [ ] **Step 3: Validate the staged plugin**

```sh
kaizen plugin validate plugins/llm-tool-approval
```

Expected: PASS.

- [ ] **Step 4: Run the full repo test suite**

```sh
bun test
```

Expected: PASS — all plugin suites green.

- [ ] **Step 5: Commit the bundle**

```sh
git add plugins/llm-tool-approval/dist/index.js
git commit -m "llm-tool-approval: rebundle for v0.2.0"
```

---

## Task 11: Marketplace + harness pin bump

The repo's marketplace catalog at `.kaizen/marketplace.json` lists every published plugin under `.entries[]`, each with its own `versions[]` array. We **add** a new `0.2.0` entry — we do not replace existing ones — so harnesses pinned to older versions remain resolvable. Then bump the one harness manifest that pins this plugin.

**Files:**
- Modify: `.kaizen/marketplace.json`
- Modify: `harnesses/local.json`

- [ ] **Step 1: Inspect the current marketplace entry**

```sh
jq '.entries[] | select(.name == "llm-tool-approval")' .kaizen/marketplace.json
```

Expected: shows the entry with a `versions` array — currently containing `0.1.1` and `0.1.0`, both pointing at `plugins/llm-tool-approval`.

- [ ] **Step 2: Prepend a new `0.2.0` version to the entry**

Open `.kaizen/marketplace.json` and find the `entries[]` element whose `name` is `"llm-tool-approval"`. In its `versions` array, **add** a new entry at the top (newest first) so the array becomes:

```json
"versions": [
  { "version": "0.2.0", "source": { "type": "file", "path": "plugins/llm-tool-approval" } },
  { "version": "0.1.1", "source": { "type": "file", "path": "plugins/llm-tool-approval" } },
  { "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-tool-approval" } }
]
```

Do not touch any other field or any other entry.

- [ ] **Step 3: Re-inspect to confirm**

```sh
jq '.entries[] | select(.name == "llm-tool-approval") | .versions[0]' .kaizen/marketplace.json
```

Expected:

```json
{
  "version": "0.2.0",
  "source": { "type": "file", "path": "plugins/llm-tool-approval" }
}
```

- [ ] **Step 4: Bump the harness pin**

In `harnesses/local.json`, change the line:

```
    "official/llm-tool-approval@0.1.1"
```

to:

```
    "official/llm-tool-approval@0.2.0"
```

Other entries are unchanged.

- [ ] **Step 5: Smoke-run the harness that loads this plugin**

```sh
kaizen --harness ./harnesses/local.json
```

Expected: harness boots cleanly. (Interactive — exit out after confirming load.)

- [ ] **Step 6: Commit**

```sh
git add .kaizen/marketplace.json harnesses/local.json
git commit -m "marketplace + local harness: bump llm-tool-approval to 0.2.0"
```

---

## Verification checklist

After all tasks complete:

- [ ] `cd plugins/llm-tool-approval && bun test` — all suites pass.
- [ ] `bun test` from repo root — all plugin suites pass.
- [ ] `kaizen plugin validate plugins/llm-tool-approval` — passes.
- [ ] `kaizen --harness ./harnesses/local.json` boots cleanly.
- [ ] Existing harness configs (e.g. `.kaizen/harnesses/official_openai-compatible/config.json`) behave unchanged — name-only allow rules continue to auto-approve.
- [ ] A `tool(pattern)` rule auto-approves matching args and prompts on non-matching args.
- [ ] A bash call with `;`, `|`, backticks, `$()`, `&&`, `||`, newline, or trailing `&` always prompts with a reason.
- [ ] Approve Pattern Always persists `tool(pattern)` to project config; empty submission falls back to approve-once.
