# llm-slash-commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `llm-slash-commands` Kaizen plugin (Spec 10 / "Spec 8" in spec doc) — a slash-command dispatcher that intercepts `input:submit`, parses `/<name> [args]`, dispatches to a registered handler, ships built-in `/help` and `/exit`, exposes a `slash:registry` service for other plugins, loads markdown commands from `~/.kaizen/commands/` and `<project>/.kaizen/commands/`, and (when present) registers a `/`-triggered source against `tui:completion`.

**Architecture:** A passive interceptor with three small subsystems: a pure parser (`parse(text)`), an in-memory registry (`Map<string, Entry>`) backing the `slash:registry` service, and a one-shot file loader. The `register()` method enforces the bare-name reservation rule: `source: "plugin"` manifests MUST contain `:` in their name, else `register()` throws `BareNamePluginError`. Built-ins shipped here (`/help`, `/exit`) are exempt; file-loaded commands are exempt; user/project markdown commands take bare names from their filename. On `input:submit` the plugin parses, dispatches, and emits `input:handled`. Re-entrancy is blocked by wrapping `ctx.emit` so handlers cannot recurse via `input:submit`.

**Tech Stack:** TypeScript, Bun runtime, native `fs/promises`, `yaml` (already vendored by kaizen). Tests use `bun:test`. Depends on `llm-events` (Spec 0) for shared types only.

---

## Prerequisites & Tier-for-Parallelism Map

This plan implements one plugin (`llm-slash-commands`). It depends on `llm-events` (already on disk per `plugins/llm-events/`) for the `Vocab` and `ChatMessage` shared types. No other plugin code is created here.

Tiers below indicate what may run in parallel (no shared writes, no read-after-write):

- **Tier 0** (sequential, blocks all others): Task 1 (scaffold package + skeleton).
- **Tier 1A** (parallel, leaf modules — no inter-task imports): Task 2 (`parser.ts`), Task 3 (`errors.ts`), Task 4 (`registry.ts`), Task 5 (`frontmatter.ts`).
- **Tier 1B** (sequential after Tier 1A): Task 6 (`builtins.ts` — uses registry), Task 7 (`file-loader.ts` — uses registry + frontmatter), Task 8 (`completion.ts` — uses registry).
- **Tier 1C** (sequential, integrates): Task 9 (`dispatcher.ts`), Task 10 (`index.ts` — wires lifecycle), Task 11 (`public.d.ts`), Task 12 (integration test + fixtures), Task 13 (marketplace catalog).

## File Structure

```
plugins/llm-slash-commands/
  package.json
  tsconfig.json
  README.md
  index.ts             # KaizenPlugin: register/start/stop, wires everything
  public.d.ts          # re-exports SlashCommandManifest/Handler/Context/RegistryService + BareNamePluginError
  parser.ts            # pure parse(text) → { name, args } | null
  errors.ts            # BareNamePluginError, ReentrantSlashEmitError, FileLoadWarning
  registry.ts          # in-memory Map; register/get/list; bare-name enforcement
  frontmatter.ts       # parseMarkdownCommandFile(path, raw) → { manifest, body } | { error }
  file-loader.ts       # discoverDirs + loadFileCommands(registry, ctx) → warnings[]
  builtins.ts          # registerBuiltins(registry, ctx) — /help, /exit
  dispatcher.ts        # onInputSubmit factory + wrapped ctx for handlers
  completion.ts        # buildCompletionSource(registry) for tui:completion
  test/
    parser.test.ts
    errors.test.ts
    registry.test.ts
    frontmatter.test.ts
    file-loader.test.ts
    builtins.test.ts
    dispatcher.test.ts
    completion.test.ts
    integration.test.ts
    fixtures/
      commands-user/
        echo.md
        bad-frontmatter.md
      commands-project/
        echo.md          # for shadow test
        required-args.md
      commands-reserved/
        help.md          # rejected at load time
```

Boundaries:
- `parser.ts` is a pure function: text → `{ name, args } | null`. No I/O.
- `errors.ts` exports typed error classes only.
- `registry.ts` owns the `Map`. Knows the bare-name rule and the `[a-z][a-z0-9-]*` per-segment rule. No fs, no events.
- `frontmatter.ts` is pure: file body string → parsed result. Wraps the `yaml` parse and validates the manifest fields it cares about.
- `file-loader.ts` is the only fs caller. Returns a warnings array; never throws on per-file problems.
- `builtins.ts` registers the two built-ins via `registry.register`.
- `dispatcher.ts` owns the `onInputSubmit` event handler factory and the per-handler context wrapping (the `emit` proxy + `print` helper + `inSlashDispatch` flag).
- `completion.ts` is a pure factory returning a `CompletionSource`.
- `index.ts` is the only file with `KaizenPlugin` lifecycle — composes the above.

`.kaizen/marketplace.json` is also modified (Task 13).

---

## Task 1: Scaffold `llm-slash-commands` plugin skeleton

**Files:**
- Create: `plugins/llm-slash-commands/package.json`
- Create: `plugins/llm-slash-commands/tsconfig.json`
- Create: `plugins/llm-slash-commands/README.md`
- Create: `plugins/llm-slash-commands/index.ts` (placeholder)
- Create: `plugins/llm-slash-commands/public.d.ts` (placeholder)

The placeholder index/public is required so `bun install` and TypeScript can resolve the workspace package; module bodies are filled in by Tasks 10/11.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "llm-slash-commands",
  "version": "0.1.0",
  "description": "Slash command registry, dispatcher, and file loader for the openai-compatible harness.",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "dependencies": {
    "llm-events": "workspace:*",
    "yaml": "^2.5.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 3: Write placeholder `index.ts`**

```ts
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-slash-commands",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["slash:registry"] },
  async setup(ctx) {
    // Filled in by Task 10.
    ctx.defineService("slash:registry", { description: "Slash command registry." });
  },
};

export default plugin;
```

- [ ] **Step 4: Write placeholder `public.d.ts`**

```ts
// Filled in by Task 11.
export type Placeholder = never;
```

- [ ] **Step 5: Write `README.md`**

```markdown
# llm-slash-commands

Slash-command dispatcher for the openai-compatible harness. Subscribes to
`input:submit`, parses `/<name> [args]`, dispatches to a registered handler.
Provides the `slash:registry` service so other plugins can register namespaced
commands (`mcp:reload`, `skills:list`, etc.). Bare names are reserved for
built-ins (`/help`, `/exit`), driver-coupled commands (`/clear`, `/model`,
registered by `llm-driver`), and user/project markdown files in
`~/.kaizen/commands/` and `<project>/.kaizen/commands/`.
```

- [ ] **Step 6: Refresh workspace install**

Run: `bun install`
Expected: workspace resolves `llm-slash-commands`; no errors. `yaml` is added to lockfile.

- [ ] **Step 7: Sanity test placeholder**

Run: `bun -e "import('./plugins/llm-slash-commands/index.ts').then(m => console.log(m.default.name))"`
Expected: `llm-slash-commands`.

- [ ] **Step 8: Commit**

```bash
git add plugins/llm-slash-commands/
git commit -m "feat(llm-slash-commands): scaffold plugin package (skeleton only)"
```

---

## Task 2: `parser.ts` — pure slash-command parser (Tier 1A, parallelizable)

**Files:**
- Create: `plugins/llm-slash-commands/parser.ts`
- Create: `plugins/llm-slash-commands/test/parser.test.ts`

`parse(text)` returns `{ name, args } | null`. Rules from spec:

- Must start with `/`.
- Next character must be `[a-z]`.
- Name is `[a-z0-9-]+` greedy.
- After name: if EOL, `args === ""`. If next char is space, args = everything after one stripped leading space (preserve interior whitespace).
- Anything else (no space after name, or invalid char) returns `null`.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-slash-commands/test/parser.test.ts
import { describe, it, expect } from "bun:test";
import { parse } from "../parser.ts";

describe("parse", () => {
  it("parses bare command", () => {
    expect(parse("/help")).toEqual({ name: "help", args: "" });
  });

  it("parses command with single-word args", () => {
    expect(parse("/help model")).toEqual({ name: "help", args: "model" });
  });

  it("preserves interior whitespace and trailing space", () => {
    expect(parse("/note   hello   world  ")).toEqual({ name: "note", args: "  hello   world  " });
  });

  it("parses dashed name", () => {
    expect(parse("/skills-reload foo")).toEqual({ name: "skills-reload", args: "foo" });
  });

  it("parses namespaced (colon) name", () => {
    // The parser does not enforce the colon rule — that's the registry's job.
    // But the colon must be a legal char in name. Spec says `[a-z0-9-]+` per segment;
    // for parser purposes we accept colons too so namespaced commands dispatch.
    expect(parse("/mcp:reload args")).toEqual({ name: "mcp:reload", args: "args" });
  });

  it("rejects empty input", () => {
    expect(parse("")).toBeNull();
  });

  it("rejects no leading slash", () => {
    expect(parse("hello /foo")).toBeNull();
  });

  it("rejects double slash", () => {
    expect(parse("//path")).toBeNull();
  });

  it("rejects /. (path-like)", () => {
    expect(parse("/.git")).toBeNull();
  });

  it("rejects uppercase first char (case-sensitive)", () => {
    expect(parse("/Foo")).toBeNull();
  });

  it("rejects /<digit>", () => {
    expect(parse("/1foo")).toBeNull();
  });

  it("treats raw JSON arg as opaque string", () => {
    expect(parse(`/run {"x":1}`)).toEqual({ name: "run", args: `{"x":1}` });
  });

  it("rejects /<name><non-space>", () => {
    // a character outside [a-z0-9-:] terminating the name without a space → reject
    expect(parse("/foo!bar")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test plugins/llm-slash-commands/test/parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `parser.ts`**

```ts
export interface ParsedSlash {
  name: string;
  args: string;
}

// Name allows dashed segments separated by colons: e.g. "help", "mcp:reload",
// "mcp:my-server:my-prompt". Per-segment rule [a-z][a-z0-9-]*.
const NAME_RE = /^\/([a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*)(?:$|[ \t])/;

export function parse(text: string): ParsedSlash | null {
  if (!text || text[0] !== "/") return null;
  const m = NAME_RE.exec(text);
  if (!m) return null;
  const name = m[1]!;
  const after = text.slice(m[0].length);
  // m[0] consumed the optional single space/tab terminator; the leading-space
  // strip rule is "strip one leading space only", which matches what we did.
  // If the match ended at end-of-input, args is "".
  if (text.length === m[0].length && !m[0].endsWith(" ") && !m[0].endsWith("\t")) {
    return { name, args: "" };
  }
  return { name, args: after };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-slash-commands/test/parser.test.ts`
Expected: 13 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-slash-commands/parser.ts plugins/llm-slash-commands/test/parser.test.ts
git commit -m "feat(llm-slash-commands): pure slash-command parser"
```

---

## Task 3: `errors.ts` — typed error classes (Tier 1A, parallelizable)

**Files:**
- Create: `plugins/llm-slash-commands/errors.ts`
- Create: `plugins/llm-slash-commands/test/errors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-slash-commands/test/errors.test.ts
import { describe, it, expect } from "bun:test";
import {
  BareNamePluginError,
  ReentrantSlashEmitError,
  DuplicateRegistrationError,
  InvalidNameError,
} from "../errors.ts";

describe("error classes", () => {
  it("BareNamePluginError carries name and is instanceof Error", () => {
    const e = new BareNamePluginError("foo");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BareNamePluginError");
    expect(e.bareName).toBe("foo");
    expect(e.message).toMatch(/foo/);
    expect(e.message).toMatch(/<source>:<name>/);
  });

  it("ReentrantSlashEmitError flags input:submit re-entry", () => {
    const e = new ReentrantSlashEmitError("input:submit");
    expect(e.event).toBe("input:submit");
    expect(e.name).toBe("ReentrantSlashEmitError");
  });

  it("DuplicateRegistrationError carries the duplicate name", () => {
    const e = new DuplicateRegistrationError("help");
    expect(e.name).toBe("DuplicateRegistrationError");
    expect(e.duplicateName).toBe("help");
  });

  it("InvalidNameError carries the offending name", () => {
    const e = new InvalidNameError("Bad-NAME");
    expect(e.name).toBe("InvalidNameError");
    expect(e.invalidName).toBe("Bad-NAME");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-slash-commands/test/errors.test.ts`

- [ ] **Step 3: Implement `errors.ts`**

```ts
export class BareNamePluginError extends Error {
  readonly bareName: string;
  constructor(name: string) {
    super(
      `Plugin-registered slash command "${name}" must be namespaced as ` +
      `<source>:<name> (e.g. "mcp:reload", "skills:list"). Bare names are ` +
      `reserved for built-ins, driver-coupled commands, and user/project ` +
      `markdown files.`,
    );
    this.name = "BareNamePluginError";
    this.bareName = name;
  }
}

export class ReentrantSlashEmitError extends Error {
  readonly event: string;
  constructor(event: string) {
    super(`Slash-command handler attempted to emit "${event}" — not allowed inside a slash dispatch.`);
    this.name = "ReentrantSlashEmitError";
    this.event = event;
  }
}

export class DuplicateRegistrationError extends Error {
  readonly duplicateName: string;
  constructor(name: string) {
    super(`Slash command "${name}" is already registered.`);
    this.name = "DuplicateRegistrationError";
    this.duplicateName = name;
  }
}

export class InvalidNameError extends Error {
  readonly invalidName: string;
  constructor(name: string) {
    super(`Slash command name "${name}" is invalid; each segment must match [a-z][a-z0-9-]*.`);
    this.name = "InvalidNameError";
    this.invalidName = name;
  }
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-slash-commands/test/errors.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-slash-commands/errors.ts plugins/llm-slash-commands/test/errors.test.ts
git commit -m "feat(llm-slash-commands): typed error classes"
```

---

## Task 4: `registry.ts` — in-memory registry with bare-name enforcement (Tier 1A, parallelizable)

**Files:**
- Create: `plugins/llm-slash-commands/registry.ts`
- Create: `plugins/llm-slash-commands/test/registry.test.ts`

This is the load-bearing module for the bare-name reservation rule. `register()`:

1. Validates name shape per segment (`[a-z][a-z0-9-]*`, joined by `:`).
2. Throws `BareNamePluginError` iff `manifest.source === "plugin"` AND name does not contain `:`.
3. Throws `DuplicateRegistrationError` if name already in map.
4. Returns an unregister function.

`get(name)` returns the entry or undefined. `list()` returns manifests sorted by name.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-slash-commands/test/registry.test.ts
import { describe, it, expect, mock } from "bun:test";
import { createRegistry, type SlashCommandManifest } from "../registry.ts";
import {
  BareNamePluginError,
  DuplicateRegistrationError,
  InvalidNameError,
} from "../errors.ts";

const noopHandler = async () => {};

function builtin(name: string, description = "d"): SlashCommandManifest {
  return { name, description, source: "builtin" };
}
function pluginM(name: string, description = "d"): SlashCommandManifest {
  return { name, description, source: "plugin" };
}
function fileM(name: string, filePath: string, description = "d"): SlashCommandManifest {
  return { name, description, source: "file", filePath };
}

describe("createRegistry", () => {
  it("register + get round-trips manifest and handler", () => {
    const reg = createRegistry();
    const handler = mock(async () => {});
    reg.register(builtin("help"), handler);
    const got = reg.get("help");
    expect(got?.manifest.name).toBe("help");
    expect(got?.handler).toBe(handler);
  });

  it("duplicate register throws DuplicateRegistrationError", () => {
    const reg = createRegistry();
    reg.register(builtin("help"), noopHandler);
    expect(() => reg.register(builtin("help"), noopHandler)).toThrow(DuplicateRegistrationError);
  });

  it("returned unregister removes the entry", () => {
    const reg = createRegistry();
    const off = reg.register(builtin("foo"), noopHandler);
    expect(reg.get("foo")).toBeDefined();
    off();
    expect(reg.get("foo")).toBeUndefined();
  });

  it("list returns sorted manifests", () => {
    const reg = createRegistry();
    reg.register(builtin("zebra"), noopHandler);
    reg.register(builtin("apple"), noopHandler);
    reg.register(pluginM("mcp:reload"), noopHandler);
    expect(reg.list().map(m => m.name)).toEqual(["apple", "mcp:reload", "zebra"]);
  });

  describe("bare-name enforcement", () => {
    it("source=plugin + bare name throws BareNamePluginError", () => {
      const reg = createRegistry();
      expect(() => reg.register(pluginM("foo"), noopHandler)).toThrow(BareNamePluginError);
    });

    it("source=plugin + namespaced name (foo:bar) succeeds", () => {
      const reg = createRegistry();
      reg.register(pluginM("foo:bar"), noopHandler);
      expect(reg.get("foo:bar")).toBeDefined();
    });

    it("source=plugin + triple namespaced (mcp:server:prompt) succeeds", () => {
      const reg = createRegistry();
      reg.register(pluginM("mcp:my-server:my-prompt"), noopHandler);
      expect(reg.get("mcp:my-server:my-prompt")).toBeDefined();
    });

    it("source=builtin + bare name succeeds (built-ins exempt)", () => {
      const reg = createRegistry();
      reg.register(builtin("help"), noopHandler);
      expect(reg.get("help")).toBeDefined();
    });

    it("source=file + bare name succeeds (file commands exempt)", () => {
      const reg = createRegistry();
      reg.register(fileM("echo", "/p/echo.md"), noopHandler);
      expect(reg.get("echo")).toBeDefined();
    });
  });

  describe("name shape validation", () => {
    it("rejects uppercase", () => {
      const reg = createRegistry();
      expect(() => reg.register(builtin("Help"), noopHandler)).toThrow(InvalidNameError);
    });
    it("rejects starting digit", () => {
      const reg = createRegistry();
      expect(() => reg.register(builtin("1help"), noopHandler)).toThrow(InvalidNameError);
    });
    it("rejects empty segment in namespaced name", () => {
      const reg = createRegistry();
      expect(() => reg.register(pluginM("mcp::reload"), noopHandler)).toThrow(InvalidNameError);
    });
    it("rejects underscore", () => {
      const reg = createRegistry();
      expect(() => reg.register(builtin("foo_bar"), noopHandler)).toThrow(InvalidNameError);
    });
    it("accepts dashed segment", () => {
      const reg = createRegistry();
      reg.register(builtin("skills-reload"), noopHandler);
      expect(reg.get("skills-reload")).toBeDefined();
    });
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-slash-commands/test/registry.test.ts`

- [ ] **Step 3: Implement `registry.ts`**

```ts
import {
  BareNamePluginError,
  DuplicateRegistrationError,
  InvalidNameError,
} from "./errors.ts";

export interface SlashCommandContext {
  args: string;
  raw: string;
  signal: AbortSignal;
  emit: (event: string, payload: unknown) => Promise<void>;
  print: (text: string) => Promise<void>;
}

export type SlashCommandHandler = (ctx: SlashCommandContext) => Promise<void>;

export interface SlashCommandManifest {
  name: string;
  description: string;
  usage?: string;
  source: "builtin" | "plugin" | "file";
  filePath?: string;
}

export interface RegistryEntry {
  manifest: SlashCommandManifest;
  handler: SlashCommandHandler;
}

export interface SlashRegistryService {
  register(manifest: SlashCommandManifest, handler: SlashCommandHandler): () => void;
  get(name: string): RegistryEntry | undefined;
  list(): SlashCommandManifest[];
}

const SEGMENT_RE = /^[a-z][a-z0-9-]*$/;

function validateNameShape(name: string): void {
  if (!name) throw new InvalidNameError(name);
  const segments = name.split(":");
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg)) throw new InvalidNameError(name);
  }
}

export function createRegistry(): SlashRegistryService {
  const map = new Map<string, RegistryEntry>();

  return {
    register(manifest, handler) {
      validateNameShape(manifest.name);
      if (manifest.source === "plugin" && !manifest.name.includes(":")) {
        throw new BareNamePluginError(manifest.name);
      }
      if (map.has(manifest.name)) {
        throw new DuplicateRegistrationError(manifest.name);
      }
      map.set(manifest.name, { manifest, handler });
      return () => {
        const cur = map.get(manifest.name);
        if (cur && cur.handler === handler) map.delete(manifest.name);
      };
    },
    get(name) {
      return map.get(name);
    },
    list() {
      return [...map.values()]
        .map(e => e.manifest)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-slash-commands/test/registry.test.ts`
Expected: 13 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-slash-commands/registry.ts plugins/llm-slash-commands/test/registry.test.ts
git commit -m "feat(llm-slash-commands): registry with bare-name reservation enforcement"
```

---

## Task 5: `frontmatter.ts` — markdown command file parser (Tier 1A, parallelizable)

**Files:**
- Create: `plugins/llm-slash-commands/frontmatter.ts`
- Create: `plugins/llm-slash-commands/test/frontmatter.test.ts`

Pure module that takes the raw file contents (and a path for diagnostics) and returns either `{ ok: true, manifestParts, body }` or `{ ok: false, reason }`. The caller (`file-loader.ts`) builds the full manifest by combining the filename-derived `name` with the parsed parts.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-slash-commands/test/frontmatter.test.ts
import { describe, it, expect } from "bun:test";
import { parseMarkdownCommandFile } from "../frontmatter.ts";

const VALID = `---
description: Echoes its argument.
usage: "<text>"
arguments:
  required: true
---
You said: {{args}}.
`;

describe("parseMarkdownCommandFile", () => {
  it("parses valid frontmatter + body", () => {
    const r = parseMarkdownCommandFile("/p/echo.md", VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.description).toBe("Echoes its argument.");
    expect(r.usage).toBe("<text>");
    expect(r.argumentsRequired).toBe(true);
    expect(r.body).toBe("You said: {{args}}.\n");
  });

  it("treats missing frontmatter as error", () => {
    const r = parseMarkdownCommandFile("/p/no-fm.md", "Just a body.\n");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/frontmatter/i);
  });

  it("treats malformed YAML as error", () => {
    const raw = "---\ndescription: [unterminated\n---\nbody\n";
    const r = parseMarkdownCommandFile("/p/bad.md", raw);
    expect(r.ok).toBe(false);
  });

  it("missing description is an error", () => {
    const raw = "---\nusage: foo\n---\nbody\n";
    const r = parseMarkdownCommandFile("/p/x.md", raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/description/i);
  });

  it("argumentsRequired defaults to false when frontmatter omits it", () => {
    const raw = "---\ndescription: ok\n---\nbody\n";
    const r = parseMarkdownCommandFile("/p/x.md", raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.argumentsRequired).toBe(false);
  });

  it("preserves body whitespace and {{args}} occurrences", () => {
    const raw = "---\ndescription: d\n---\n{{args}} and {{args}} again\n";
    const r = parseMarkdownCommandFile("/p/x.md", raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toBe("{{args}} and {{args}} again\n");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-slash-commands/test/frontmatter.test.ts`

- [ ] **Step 3: Implement `frontmatter.ts`**

```ts
import { parse as parseYaml } from "yaml";

export type ParsedCommandFile =
  | {
      ok: true;
      description: string;
      usage?: string;
      argumentsRequired: boolean;
      body: string;
    }
  | { ok: false; reason: string };

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export function parseMarkdownCommandFile(path: string, raw: string): ParsedCommandFile {
  const m = FM_RE.exec(raw);
  if (!m) return { ok: false, reason: `${path}: missing YAML frontmatter` };
  const yamlText = m[1]!;
  const body = m[2]!;
  let fm: unknown;
  try {
    fm = parseYaml(yamlText);
  } catch (e) {
    return { ok: false, reason: `${path}: malformed YAML frontmatter: ${(e as Error).message}` };
  }
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) {
    return { ok: false, reason: `${path}: frontmatter must be a YAML mapping` };
  }
  const obj = fm as Record<string, unknown>;
  const description = obj.description;
  if (typeof description !== "string" || description.length === 0) {
    return { ok: false, reason: `${path}: frontmatter.description (string) is required` };
  }
  const usage = typeof obj.usage === "string" ? obj.usage : undefined;
  let argumentsRequired = false;
  if (obj.arguments !== undefined) {
    if (!obj.arguments || typeof obj.arguments !== "object" || Array.isArray(obj.arguments)) {
      return { ok: false, reason: `${path}: frontmatter.arguments must be a mapping` };
    }
    const a = obj.arguments as Record<string, unknown>;
    if (a.required !== undefined) {
      if (typeof a.required !== "boolean") {
        return { ok: false, reason: `${path}: frontmatter.arguments.required must be boolean` };
      }
      argumentsRequired = a.required;
    }
  }
  return { ok: true, description, usage, argumentsRequired, body };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-slash-commands/test/frontmatter.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-slash-commands/frontmatter.ts plugins/llm-slash-commands/test/frontmatter.test.ts
git commit -m "feat(llm-slash-commands): markdown command file frontmatter parser"
```

---

## Task 6: `builtins.ts` — register `/help` and `/exit` (Tier 1B)

**Files:**
- Create: `plugins/llm-slash-commands/builtins.ts`
- Create: `plugins/llm-slash-commands/test/builtins.test.ts`

`registerBuiltins(registry, deps)` registers two built-in commands. Their handlers receive a `SlashCommandContext` and use `ctx.print` (for `/help`) or `ctx.emit` (for `/exit`).

`/help` behavior:
- `args === ""` → print all commands grouped by source. Sections in order: **Built-in** (`source==="builtin"` AND no colon), **Driver** (`source==="builtin"` AND name has colon prefix from `llm-driver` — i.e. names `clear`/`model`; we group by hardcoded driver-name set OR by namespace prefix), **Skills** (`name.startsWith("skills:")` or bare `skills`), **Agents** (`agents:`), **Memory** (`memory:`), **MCP** (`mcp:`), **User** (`source === "file"`). Anything else falls under a final **Other** group only if non-empty (to avoid silently dropping plugin commands with unrecognized prefixes).
- `args !== ""` → print the entry for that command (or "Unknown command" if absent). Include `filePath` for `source: "file"` entries.

`/exit` behavior:
- Emit `session:end` with `{}`. Do not call `process.exit`.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-slash-commands/test/builtins.test.ts
import { describe, it, expect, mock } from "bun:test";
import { createRegistry } from "../registry.ts";
import { registerBuiltins } from "../builtins.ts";

function makeCtx() {
  const printed: string[] = [];
  const emitted: { event: string; payload: unknown }[] = [];
  const ctx = {
    args: "",
    raw: "",
    signal: new AbortController().signal,
    emit: mock(async (event: string, payload: unknown) => { emitted.push({ event, payload }); }),
    print: mock(async (text: string) => { printed.push(text); }),
  };
  return { ctx, printed, emitted };
}

describe("registerBuiltins", () => {
  it("registers /help and /exit on the registry", () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    expect(reg.get("help")).toBeDefined();
    expect(reg.get("exit")).toBeDefined();
    expect(reg.get("help")!.manifest.source).toBe("builtin");
  });

  it("/exit emits session:end exactly once with {}", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    const { ctx, emitted } = makeCtx();
    await reg.get("exit")!.handler(ctx as any);
    expect(emitted).toEqual([{ event: "session:end", payload: {} }]);
  });

  it("/help with no args groups all registered commands", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    // Simulate driver-coupled built-ins:
    reg.register({ name: "clear", description: "Clear conv", source: "builtin" }, async () => {});
    reg.register({ name: "model", description: "Pick model", source: "builtin", usage: "<id>" }, async () => {});
    // Simulate plugin namespaced:
    reg.register({ name: "mcp:reload", description: "Reload MCP", source: "plugin" }, async () => {});
    reg.register({ name: "skills:list", description: "List skills", source: "plugin" }, async () => {});
    // Simulate file-loaded:
    reg.register({ name: "echo", description: "Echo", source: "file", filePath: "/p/echo.md" }, async () => {});

    const { ctx, printed } = makeCtx();
    await reg.get("help")!.handler(ctx as any);
    const text = printed.join("\n");
    expect(text).toContain("Built-in");
    expect(text).toContain("/help");
    expect(text).toContain("/exit");
    expect(text).toContain("Driver");
    expect(text).toContain("/clear");
    expect(text).toContain("/model <id>");
    expect(text).toContain("MCP");
    expect(text).toContain("/mcp:reload");
    expect(text).toContain("Skills");
    expect(text).toContain("/skills:list");
    expect(text).toContain("User");
    expect(text).toContain("/echo");
    // Section ordering
    const order = ["Built-in", "Driver", "Skills", "MCP", "User"];
    let last = -1;
    for (const label of order) {
      const idx = text.indexOf(label);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("/help <name> prints just that entry including filePath for file commands", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    reg.register({ name: "echo", description: "Echo", source: "file", filePath: "/p/echo.md", usage: "[text]" }, async () => {});
    const { ctx, printed } = makeCtx();
    ctx.args = "echo";
    await reg.get("help")!.handler(ctx as any);
    const text = printed.join("\n");
    expect(text).toContain("/echo [text]");
    expect(text).toContain("Echo");
    expect(text).toContain("/p/echo.md");
  });

  it("/help <unknown> prints unknown-command line", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    const { ctx, printed } = makeCtx();
    ctx.args = "nope";
    await reg.get("help")!.handler(ctx as any);
    expect(printed.join("\n")).toMatch(/Unknown command: \/nope/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-slash-commands/test/builtins.test.ts`

- [ ] **Step 3: Implement `builtins.ts`**

```ts
import type {
  SlashCommandContext,
  SlashCommandManifest,
  SlashRegistryService,
} from "./registry.ts";

interface Group {
  label: string;
  match: (m: SlashCommandManifest) => boolean;
}

const DRIVER_BARE_NAMES = new Set(["clear", "model"]);

const GROUPS: Group[] = [
  // Built-ins shipped by this plugin (bare names not in the driver set).
  { label: "Built-in", match: (m) => m.source === "builtin" && !m.name.includes(":") && !DRIVER_BARE_NAMES.has(m.name) },
  { label: "Driver",   match: (m) => m.source === "builtin" && DRIVER_BARE_NAMES.has(m.name) },
  { label: "Skills",   match: (m) => m.name === "skills" || m.name.startsWith("skills:") || m.name.startsWith("skills-") },
  { label: "Agents",   match: (m) => m.name === "agents" || m.name.startsWith("agents:") },
  { label: "Memory",   match: (m) => m.name.startsWith("memory:") },
  { label: "MCP",      match: (m) => m.name.startsWith("mcp:") },
  { label: "User",     match: (m) => m.source === "file" },
];

function formatLine(m: SlashCommandManifest): string {
  const head = m.usage ? `/${m.name} ${m.usage}` : `/${m.name}`;
  return `  ${head} — ${m.description}`;
}

function formatEntry(m: SlashCommandManifest): string {
  const head = m.usage ? `/${m.name} ${m.usage}` : `/${m.name}`;
  const tail = m.filePath ? `\n  source: ${m.filePath}` : "";
  return `${head} — ${m.description}${tail}`;
}

function helpAll(registry: SlashRegistryService): string {
  const all = registry.list();
  const lines: string[] = [];
  const consumed = new Set<string>();

  for (const g of GROUPS) {
    const items = all.filter((m) => !consumed.has(m.name) && g.match(m));
    if (items.length === 0) continue;
    items.forEach((m) => consumed.add(m.name));
    lines.push(g.label);
    for (const m of items) lines.push(formatLine(m));
    lines.push("");
  }

  const rest = all.filter((m) => !consumed.has(m.name));
  if (rest.length) {
    lines.push("Other");
    for (const m of rest) lines.push(formatLine(m));
    lines.push("");
  }

  return lines.join("\n").replace(/\n+$/, "");
}

export function registerBuiltins(registry: SlashRegistryService): void {
  registry.register(
    { name: "help", description: "List available slash commands", source: "builtin", usage: "[command]" },
    async (ctx: SlashCommandContext) => {
      const arg = ctx.args.trim();
      if (!arg) {
        await ctx.print(helpAll(registry));
        return;
      }
      const entry = registry.get(arg);
      if (!entry) {
        await ctx.print(`Unknown command: /${arg}.`);
        return;
      }
      await ctx.print(formatEntry(entry.manifest));
    },
  );

  registry.register(
    { name: "exit", description: "End the session", source: "builtin" },
    async (ctx: SlashCommandContext) => {
      await ctx.emit("session:end", {});
    },
  );
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-slash-commands/test/builtins.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-slash-commands/builtins.ts plugins/llm-slash-commands/test/builtins.test.ts
git commit -m "feat(llm-slash-commands): /help and /exit built-ins"
```

---

## Task 7: `file-loader.ts` — discover and load markdown commands (Tier 1B)

**Files:**
- Create: `plugins/llm-slash-commands/file-loader.ts`
- Create: `plugins/llm-slash-commands/test/file-loader.test.ts`

`loadFileCommands(deps)` walks user dir then project dir, parses each `*.md`, and registers a wrapping handler that:

1. Validates `args` against `argumentsRequired`.
2. Renders body by replacing every `{{args}}` with `ctx.args`.
3. Emits `conversation:user-message` with `{ message: { role: "user", content: rendered } }`.
4. Calls `runConversation` from the optional `driver:run-conversation` service if available.

The loader is a pure-ish function that takes a `deps` facade (`{ home, cwd, readDir, readFile, registry, getDriver }`). On per-file errors (missing frontmatter, malformed YAML, name collision), the loader pushes a warning into a returned `string[]` and continues. The plugin's `start()` later flushes warnings to a single `conversation:system-message`.

Project-over-user shadowing: project files are loaded second; collisions caught by `DuplicateRegistrationError` get a warning. Reserved-name rejection: a file named `help.md` (or any name already registered as a built-in) is skipped with a warning that includes the file path and the reserved name.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-slash-commands/test/file-loader.test.ts
import { describe, it, expect, mock } from "bun:test";
import { createRegistry } from "../registry.ts";
import { registerBuiltins } from "../builtins.ts";
import { loadFileCommands, type FileLoaderDeps } from "../file-loader.ts";

function makeFsDeps(files: Record<string, string>): Pick<FileLoaderDeps, "readDir" | "readFile"> {
  return {
    readDir: async (dir: string) => {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      return Object.keys(files)
        .filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map(p => p.slice(prefix.length));
    },
    readFile: async (path: string) => {
      if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[path]!;
    },
  };
}

const VALID = `---
description: Echo your input.
---
You said: {{args}}.
`;

describe("loadFileCommands", () => {
  it("registers a file command from user dir", async () => {
    const reg = createRegistry();
    const fs = makeFsDeps({ "/u/.kaizen/commands/echo.md": VALID });
    const warnings = await loadFileCommands({
      home: "/u", cwd: "/p", registry: reg, ...fs, getDriver: () => undefined,
    });
    expect(warnings).toEqual([]);
    const m = reg.get("echo")!.manifest;
    expect(m.source).toBe("file");
    expect(m.filePath).toBe("/u/.kaizen/commands/echo.md");
  });

  it("project shadows user (project wins) with debug warning suppressed but DuplicateRegistrationError surfaced", async () => {
    const reg = createRegistry();
    // user first, then project — but our loader always loads user first; if both exist with same name,
    // project must replace user. Loader needs to unregister the user entry before registering project.
    const fs = makeFsDeps({
      "/u/.kaizen/commands/echo.md": VALID,
      "/p/.kaizen/commands/echo.md": VALID.replace("Echo your input.", "Project echo."),
    });
    const warnings = await loadFileCommands({
      home: "/u", cwd: "/p", registry: reg, ...fs, getDriver: () => undefined,
    });
    expect(warnings).toEqual([]);
    expect(reg.get("echo")!.manifest.description).toBe("Project echo.");
    expect(reg.get("echo")!.manifest.filePath).toBe("/p/.kaizen/commands/echo.md");
  });

  it("rejects a file colliding with a built-in (e.g. help.md) with a clear warning", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    const fs = makeFsDeps({ "/u/.kaizen/commands/help.md": VALID });
    const warnings = await loadFileCommands({
      home: "/u", cwd: "/p", registry: reg, ...fs, getDriver: () => undefined,
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/help\.md/);
    expect(warnings[0]).toMatch(/reserved/i);
    expect(reg.get("help")!.manifest.source).toBe("builtin");
  });

  it("malformed frontmatter → file skipped with warning, no crash", async () => {
    const reg = createRegistry();
    const fs = makeFsDeps({ "/u/.kaizen/commands/bad.md": "no frontmatter here\n" });
    const warnings = await loadFileCommands({
      home: "/u", cwd: "/p", registry: reg, ...fs, getDriver: () => undefined,
    });
    expect(reg.get("bad")).toBeUndefined();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/bad\.md/);
  });

  it("invokes handler: substitutes {{args}}, emits conversation:user-message, calls runConversation", async () => {
    const reg = createRegistry();
    const fs = makeFsDeps({ "/u/.kaizen/commands/echo.md": VALID });
    const emit = mock(async (_e: string, _p: unknown) => {});
    const runConversation = mock(async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }));
    const driver = { runConversation };
    await loadFileCommands({
      home: "/u", cwd: "/p", registry: reg, ...fs, getDriver: () => driver as any,
    });
    const ctx: any = { args: "hello world", raw: "/echo hello world", signal: new AbortController().signal, emit, print: async () => {} };
    await reg.get("echo")!.handler(ctx);
    const userMsgCalls = emit.mock.calls.filter((c) => c[0] === "conversation:user-message");
    expect(userMsgCalls.length).toBe(1);
    const payload: any = userMsgCalls[0]![1];
    expect(payload.message.role).toBe("user");
    expect(payload.message.content).toBe("You said: hello world.\n");
    expect(runConversation).toHaveBeenCalledTimes(1);
  });

  it("required-args validation: empty args prints usage and does NOT call runConversation", async () => {
    const reg = createRegistry();
    const fs = makeFsDeps({
      "/u/.kaizen/commands/needy.md": `---\ndescription: needs args\nusage: "<text>"\narguments:\n  required: true\n---\nyou: {{args}}\n`,
    });
    const runConversation = mock(async () => ({} as any));
    await loadFileCommands({
      home: "/u", cwd: "/p", registry: reg, ...fs, getDriver: () => ({ runConversation } as any),
    });
    const printed: string[] = [];
    const emit = mock(async () => {});
    const ctx: any = { args: "", raw: "/needy", signal: new AbortController().signal, emit, print: async (t: string) => { printed.push(t); } };
    await reg.get("needy")!.handler(ctx);
    expect(runConversation).not.toHaveBeenCalled();
    expect(printed.join("\n")).toMatch(/requires arguments/);
    expect(printed.join("\n")).toMatch(/<text>/);
  });

  it("missing dirs are tolerated", async () => {
    const reg = createRegistry();
    const fs: Pick<FileLoaderDeps, "readDir" | "readFile"> = {
      readDir: async () => { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
      readFile: async () => { throw new Error("unreachable"); },
    };
    const warnings = await loadFileCommands({
      home: "/u", cwd: "/p", registry: reg, ...fs, getDriver: () => undefined,
    });
    expect(warnings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-slash-commands/test/file-loader.test.ts`

- [ ] **Step 3: Implement `file-loader.ts`**

```ts
import { parseMarkdownCommandFile } from "./frontmatter.ts";
import type { SlashRegistryService, SlashCommandHandler, SlashCommandContext } from "./registry.ts";
import { DuplicateRegistrationError } from "./errors.ts";

export interface DriverLike {
  runConversation(input: {
    systemPrompt?: string;
    messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[];
    signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface FileLoaderDeps {
  home: string;
  cwd: string;
  registry: SlashRegistryService;
  readDir: (path: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  getDriver: () => DriverLike | undefined;
}

interface DiscoveredFile {
  scope: "user" | "project";
  dir: string;
  fileName: string;
  fullPath: string;
}

export async function loadFileCommands(deps: FileLoaderDeps): Promise<string[]> {
  const warnings: string[] = [];
  const userDir = `${deps.home.replace(/\/$/, "")}/.kaizen/commands`;
  const projectDir = `${deps.cwd.replace(/\/$/, "")}/.kaizen/commands`;

  const userFiles = await listMarkdown(deps, userDir, "user");
  const projectFiles = await listMarkdown(deps, projectDir, "project");

  // user first, then project so project shadows user.
  for (const f of userFiles) await loadOne(deps, f, warnings, /*allowReplace*/ false);
  for (const f of projectFiles) await loadOne(deps, f, warnings, /*allowReplace*/ true);

  return warnings;
}

async function listMarkdown(deps: FileLoaderDeps, dir: string, scope: "user" | "project"): Promise<DiscoveredFile[]> {
  let entries: string[];
  try {
    entries = await deps.readDir(dir);
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    return [];
  }
  return entries
    .filter(n => n.endsWith(".md"))
    .map(n => ({ scope, dir, fileName: n, fullPath: `${dir}/${n}` }));
}

async function loadOne(
  deps: FileLoaderDeps,
  f: DiscoveredFile,
  warnings: string[],
  allowReplace: boolean,
): Promise<void> {
  const name = f.fileName.replace(/\.md$/, "");
  let raw: string;
  try { raw = await deps.readFile(f.fullPath); }
  catch (e) { warnings.push(`${f.fullPath}: failed to read: ${(e as Error).message}`); return; }

  const parsed = parseMarkdownCommandFile(f.fullPath, raw);
  if (!parsed.ok) { warnings.push(parsed.reason); return; }

  // Reserved-name check: if a non-file entry with this name exists already, skip with warning.
  // For project files, allow replacing a previously-registered USER FILE entry.
  const existing = deps.registry.get(name);
  if (existing) {
    if (allowReplace && existing.manifest.source === "file") {
      // unregister-user-then-register-project: registry has no public unregister-by-name,
      // but it returns an off function from register. We don't have that here, so use a
      // delete-and-reinsert dance via the public list/get + register only if absent.
      // To keep the registry API clean, we expose a tiny helper: the caller (this loader)
      // tracks the off-functions it received and can call them. We track them per-file:
      const off = userOffs.get(name);
      if (off) { off(); userOffs.delete(name); }
    } else {
      warnings.push(
        `${f.fullPath}: skipped — name "${name}" is reserved (already registered by ${existing.manifest.source}).`,
      );
      return;
    }
  }

  const handler = makeHandler(name, parsed.argumentsRequired, parsed.usage, parsed.body, deps);

  try {
    const off = deps.registry.register(
      { name, description: parsed.description, usage: parsed.usage, source: "file", filePath: f.fullPath },
      handler,
    );
    if (f.scope === "user") userOffs.set(name, off);
  } catch (e) {
    if (e instanceof DuplicateRegistrationError) {
      warnings.push(`${f.fullPath}: duplicate registration for "${name}".`);
    } else {
      warnings.push(`${f.fullPath}: registration failed: ${(e as Error).message}`);
    }
  }
}

// Module-scoped map of user-scope unregister fns so project files can replace them.
// Cleared at start of each loadFileCommands call by re-creating it on entry below.
let userOffs: Map<string, () => void> = new Map();

function makeHandler(
  name: string,
  argumentsRequired: boolean,
  usage: string | undefined,
  body: string,
  deps: FileLoaderDeps,
): SlashCommandHandler {
  return async (ctx: SlashCommandContext) => {
    if (argumentsRequired && ctx.args.trim() === "") {
      const u = usage ? ` ${usage}` : "";
      await ctx.print(`Command /${name} requires arguments. Usage: /${name}${u}`);
      return;
    }
    const rendered = body.split("{{args}}").join(ctx.args);
    await ctx.emit("conversation:user-message", {
      message: { role: "user", content: rendered },
    });
    const driver = deps.getDriver();
    if (driver) {
      await driver.runConversation({
        messages: [{ role: "user", content: rendered }],
        signal: ctx.signal,
      });
    }
  };
}

// Reset the user-offs map at the start of each loader invocation.
const _origLoad = loadFileCommands;
export async function _resetUserOffs(): Promise<void> { userOffs = new Map(); }
```

NOTE: the implementation uses a module-scoped `userOffs` map. Replace the file body above with this clean, idiomatic version that tracks `userOffs` locally inside the function and threads it through `loadOne` (no module state):

```ts
import { parseMarkdownCommandFile } from "./frontmatter.ts";
import type { SlashRegistryService, SlashCommandHandler, SlashCommandContext } from "./registry.ts";
import { DuplicateRegistrationError } from "./errors.ts";

export interface DriverLike {
  runConversation(input: {
    systemPrompt?: string;
    messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[];
    signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface FileLoaderDeps {
  home: string;
  cwd: string;
  registry: SlashRegistryService;
  readDir: (path: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  getDriver: () => DriverLike | undefined;
}

interface DiscoveredFile {
  scope: "user" | "project";
  dir: string;
  fileName: string;
  fullPath: string;
}

export async function loadFileCommands(deps: FileLoaderDeps): Promise<string[]> {
  const warnings: string[] = [];
  const userOffs = new Map<string, () => void>();
  const userDir = `${deps.home.replace(/\/$/, "")}/.kaizen/commands`;
  const projectDir = `${deps.cwd.replace(/\/$/, "")}/.kaizen/commands`;

  for (const f of await listMarkdown(deps, userDir, "user")) {
    await loadOne(deps, f, warnings, userOffs, /*allowReplace*/ false);
  }
  for (const f of await listMarkdown(deps, projectDir, "project")) {
    await loadOne(deps, f, warnings, userOffs, /*allowReplace*/ true);
  }
  return warnings;
}

async function listMarkdown(deps: FileLoaderDeps, dir: string, scope: "user" | "project"): Promise<DiscoveredFile[]> {
  let entries: string[];
  try { entries = await deps.readDir(dir); }
  catch { return []; }
  return entries
    .filter((n) => n.endsWith(".md"))
    .map((n) => ({ scope, dir, fileName: n, fullPath: `${dir}/${n}` }));
}

async function loadOne(
  deps: FileLoaderDeps,
  f: DiscoveredFile,
  warnings: string[],
  userOffs: Map<string, () => void>,
  allowReplace: boolean,
): Promise<void> {
  const name = f.fileName.replace(/\.md$/, "");
  let raw: string;
  try { raw = await deps.readFile(f.fullPath); }
  catch (e) { warnings.push(`${f.fullPath}: failed to read: ${(e as Error).message}`); return; }

  const parsed = parseMarkdownCommandFile(f.fullPath, raw);
  if (!parsed.ok) { warnings.push(parsed.reason); return; }

  const existing = deps.registry.get(name);
  if (existing) {
    if (allowReplace && existing.manifest.source === "file") {
      const off = userOffs.get(name);
      if (off) { off(); userOffs.delete(name); }
    } else {
      warnings.push(`${f.fullPath}: skipped — name "${name}" is reserved (already registered by ${existing.manifest.source}).`);
      return;
    }
  }

  const handler = makeHandler(name, parsed.argumentsRequired, parsed.usage, parsed.body, deps);
  try {
    const off = deps.registry.register(
      { name, description: parsed.description, usage: parsed.usage, source: "file", filePath: f.fullPath },
      handler,
    );
    if (f.scope === "user") userOffs.set(name, off);
  } catch (e) {
    if (e instanceof DuplicateRegistrationError) warnings.push(`${f.fullPath}: duplicate registration for "${name}".`);
    else warnings.push(`${f.fullPath}: registration failed: ${(e as Error).message}`);
  }
}

function makeHandler(
  name: string,
  argumentsRequired: boolean,
  usage: string | undefined,
  body: string,
  deps: FileLoaderDeps,
): SlashCommandHandler {
  return async (ctx: SlashCommandContext) => {
    if (argumentsRequired && ctx.args.trim() === "") {
      const u = usage ? ` ${usage}` : "";
      await ctx.print(`Command /${name} requires arguments. Usage: /${name}${u}`);
      return;
    }
    const rendered = body.split("{{args}}").join(ctx.args);
    await ctx.emit("conversation:user-message", { message: { role: "user", content: rendered } });
    const driver = deps.getDriver();
    if (driver) {
      await driver.runConversation({
        messages: [{ role: "user", content: rendered }],
        signal: ctx.signal,
      });
    }
  };
}
```

Use only the second (clean) version when implementing the file. The first block is shown for reference only — DELETE it before saving the file.

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-slash-commands/test/file-loader.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-slash-commands/file-loader.ts plugins/llm-slash-commands/test/file-loader.test.ts
git commit -m "feat(llm-slash-commands): markdown command file loader"
```

---

## Task 8: `completion.ts` — `tui:completion` source factory (Tier 1B)

**Files:**
- Create: `plugins/llm-slash-commands/completion.ts`
- Create: `plugins/llm-slash-commands/test/completion.test.ts`

`buildCompletionSource(registry)` returns a `CompletionSource` with `trigger: "/"` whose `list(input, cursor)` returns matching items, sorted built-ins first then alphabetical within namespace.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-slash-commands/test/completion.test.ts
import { describe, it, expect } from "bun:test";
import { createRegistry } from "../registry.ts";
import { registerBuiltins } from "../builtins.ts";
import { buildCompletionSource } from "../completion.ts";

describe("buildCompletionSource", () => {
  it("returns trigger='/' source", () => {
    const reg = createRegistry();
    const src = buildCompletionSource(reg);
    expect(src.trigger).toBe("/");
  });

  it("filters by prefix after the slash", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    reg.register({ name: "mcp:reload", description: "r", source: "plugin" }, async () => {});
    const src = buildCompletionSource(reg);
    const items = await src.list("/he", 3);
    expect(items.map((i) => i.label)).toEqual(["/help"]);
    expect(items[0]!.insertText).toBe("/help ");
  });

  it("returns all when prefix empty", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    reg.register({ name: "mcp:reload", description: "r", source: "plugin" }, async () => {});
    const src = buildCompletionSource(reg);
    const items = await src.list("/", 1);
    expect(items.length).toBe(3);
    // Built-ins before namespaced.
    expect(items[0]!.label).toMatch(/^\/(help|exit)$/);
    expect(items[items.length - 1]!.label).toBe("/mcp:reload");
  });

  it("returns description per item", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    const src = buildCompletionSource(reg);
    const items = await src.list("/help", 5);
    expect(items[0]!.description).toMatch(/slash commands/i);
  });

  it("returns [] when input doesn't start with /", async () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    const src = buildCompletionSource(reg);
    expect(await src.list("hello", 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-slash-commands/test/completion.test.ts`

- [ ] **Step 3: Implement `completion.ts`**

```ts
import type { SlashRegistryService, SlashCommandManifest } from "./registry.ts";

export interface CompletionItem {
  label: string;
  insertText: string;
  description?: string;
}

export interface CompletionSource {
  trigger: string;
  list(input: string, cursor: number): Promise<CompletionItem[]>;
}

function rank(m: SlashCommandManifest): number {
  if (m.source === "builtin" && !m.name.includes(":")) return 0;
  if (m.source === "file") return 1;
  return 2;
}

export function buildCompletionSource(registry: SlashRegistryService): CompletionSource {
  return {
    trigger: "/",
    async list(input: string, cursor: number): Promise<CompletionItem[]> {
      if (!input.startsWith("/")) return [];
      const prefix = input.slice(1, cursor);
      const all = registry.list();
      return all
        .filter((m) => m.name.startsWith(prefix))
        .sort((a, b) => {
          const ra = rank(a), rb = rank(b);
          if (ra !== rb) return ra - rb;
          return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        })
        .map((m) => ({
          label: `/${m.name}`,
          insertText: `/${m.name} `,
          description: m.description,
        }));
    },
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-slash-commands/test/completion.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-slash-commands/completion.ts plugins/llm-slash-commands/test/completion.test.ts
git commit -m "feat(llm-slash-commands): tui:completion source factory"
```

---

## Task 9: `dispatcher.ts` — `input:submit` handler factory (Tier 1C)

**Files:**
- Create: `plugins/llm-slash-commands/dispatcher.ts`
- Create: `plugins/llm-slash-commands/test/dispatcher.test.ts`

`makeOnInputSubmit(deps)` returns an async function suitable for `ctx.subscribe("input:submit", fn, { priority: 100 })`. It:

1. Calls `parse(payload.text)`. If null → return immediately (fall through).
2. If `inSlashDispatch` flag is set → return immediately (defense in depth).
3. Sets the flag, builds wrapped context (with `emit` proxy that throws `ReentrantSlashEmitError` if event === `input:submit`, plus `print` helper that emits `conversation:system-message`), looks up the command.
4. If not found → emit `conversation:system-message` with the unknown-command line, emit `input:handled`, clear flag, return.
5. If found → `await handler(wrappedCtx)`. On any throw, emit `session:error`. Always emit `input:handled` after.
6. Clear flag.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/llm-slash-commands/test/dispatcher.test.ts
import { describe, it, expect, mock } from "bun:test";
import { createRegistry } from "../registry.ts";
import { registerBuiltins } from "../builtins.ts";
import { makeOnInputSubmit } from "../dispatcher.ts";
import { ReentrantSlashEmitError } from "../errors.ts";

function makeBus() {
  const emitted: { event: string; payload: unknown }[] = [];
  return {
    emitted,
    emit: mock(async (event: string, payload: unknown) => { emitted.push({ event, payload }); }),
    signal: new AbortController().signal,
  };
}

describe("makeOnInputSubmit", () => {
  it("non-slash input: no-op (no input:handled)", async () => {
    const reg = createRegistry(); registerBuiltins(reg);
    const bus = makeBus();
    const fn = makeOnInputSubmit({ registry: reg, bus });
    await fn({ text: "hello" });
    expect(bus.emitted).toEqual([]);
  });

  it("matched /help: calls handler and emits input:handled", async () => {
    const reg = createRegistry(); registerBuiltins(reg);
    const bus = makeBus();
    const fn = makeOnInputSubmit({ registry: reg, bus });
    await fn({ text: "/help" });
    const handled = bus.emitted.find((e) => e.event === "input:handled");
    expect(handled?.payload).toEqual({ by: "llm-slash-commands" });
  });

  it("unknown command: prints system message and emits input:handled", async () => {
    const reg = createRegistry(); registerBuiltins(reg);
    const bus = makeBus();
    const fn = makeOnInputSubmit({ registry: reg, bus });
    await fn({ text: "/nope" });
    const sys = bus.emitted.find((e) => e.event === "conversation:system-message");
    expect(sys).toBeDefined();
    expect((sys!.payload as any).message.content).toMatch(/Unknown command: \/nope/);
    expect(bus.emitted.find((e) => e.event === "input:handled")).toBeDefined();
  });

  it("handler throwing: surfaces session:error AND still emits input:handled", async () => {
    const reg = createRegistry();
    reg.register({ name: "boom", description: "d", source: "builtin" }, async () => { throw new Error("kapow"); });
    const bus = makeBus();
    const fn = makeOnInputSubmit({ registry: reg, bus });
    await fn({ text: "/boom" });
    const err = bus.emitted.find((e) => e.event === "session:error");
    expect(err).toBeDefined();
    expect((err!.payload as any).message).toMatch(/kapow/);
    expect(bus.emitted.find((e) => e.event === "input:handled")).toBeDefined();
  });

  it("handler that emits input:submit: wrapped emit throws ReentrantSlashEmitError surfaced via session:error", async () => {
    const reg = createRegistry();
    reg.register({ name: "loopy", description: "d", source: "builtin" }, async (ctx) => {
      await ctx.emit("input:submit", { text: "/help" });
    });
    const bus = makeBus();
    const fn = makeOnInputSubmit({ registry: reg, bus });
    await fn({ text: "/loopy" });
    const err = bus.emitted.find((e) => e.event === "session:error") as any;
    expect(err).toBeDefined();
    expect(String(err.payload.message)).toMatch(/input:submit/);
    expect(bus.emitted.find((e) => e.event === "input:handled")).toBeDefined();
  });

  it("re-entry guard: invoking the subscriber while inSlashDispatch is set returns immediately", async () => {
    const reg = createRegistry();
    let inner: any = null;
    reg.register({ name: "outer", description: "d", source: "builtin" }, async () => {
      // Simulate a sneaky re-entry: invoke the subscriber directly during dispatch.
      await inner!({ text: "/help" });
    });
    registerBuiltins(reg);
    const bus = makeBus();
    inner = makeOnInputSubmit({ registry: reg, bus });
    await inner({ text: "/outer" });
    // Only one input:handled (from outer) — the inner /help call was ignored.
    const handled = bus.emitted.filter((e) => e.event === "input:handled");
    expect(handled.length).toBe(1);
  });

  it("ctx.print emits conversation:system-message with role:system", async () => {
    const reg = createRegistry();
    reg.register({ name: "say", description: "d", source: "builtin" }, async (ctx) => {
      await ctx.print("hello world");
    });
    const bus = makeBus();
    const fn = makeOnInputSubmit({ registry: reg, bus });
    await fn({ text: "/say" });
    const sys = bus.emitted.find((e) => e.event === "conversation:system-message") as any;
    expect(sys).toBeDefined();
    expect(sys.payload.message.role).toBe("system");
    expect(sys.payload.message.content).toBe("hello world");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test plugins/llm-slash-commands/test/dispatcher.test.ts`

- [ ] **Step 3: Implement `dispatcher.ts`**

```ts
import { parse } from "./parser.ts";
import type { SlashRegistryService, SlashCommandContext } from "./registry.ts";
import { ReentrantSlashEmitError } from "./errors.ts";

export interface DispatcherBus {
  emit: (event: string, payload: unknown) => Promise<void>;
  signal: AbortSignal;
}

export interface DispatcherDeps {
  registry: SlashRegistryService;
  bus: DispatcherBus;
}

export function makeOnInputSubmit(deps: DispatcherDeps): (payload: { text: string }) => Promise<void> {
  let inSlashDispatch = false;

  return async function onInputSubmit(payload: { text: string }) {
    if (inSlashDispatch) return;
    const parsed = parse(payload.text);
    if (!parsed) return;

    inSlashDispatch = true;
    try {
      const wrappedEmit = async (event: string, p: unknown) => {
        if (event === "input:submit") throw new ReentrantSlashEmitError(event);
        await deps.bus.emit(event, p);
      };
      const print = async (text: string) => {
        await deps.bus.emit("conversation:system-message", {
          message: { role: "system", content: text },
        });
      };
      const ctx: SlashCommandContext = {
        args: parsed.args,
        raw: payload.text,
        signal: deps.bus.signal,
        emit: wrappedEmit,
        print,
      };

      const entry = deps.registry.get(parsed.name);
      if (!entry) {
        await deps.bus.emit("conversation:system-message", {
          message: { role: "system", content: `Unknown command: /${parsed.name}. Type /help for a list.` },
        });
      } else {
        try {
          await entry.handler(ctx);
        } catch (e) {
          await deps.bus.emit("session:error", {
            message: (e as Error).message ?? String(e),
            cause: e,
          });
        }
      }
      await deps.bus.emit("input:handled", { by: "llm-slash-commands" });
    } finally {
      inSlashDispatch = false;
    }
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test plugins/llm-slash-commands/test/dispatcher.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-slash-commands/dispatcher.ts plugins/llm-slash-commands/test/dispatcher.test.ts
git commit -m "feat(llm-slash-commands): input:submit dispatcher with reentrancy guard"
```

---

## Task 10: `index.ts` — wire lifecycle (Tier 1C)

**Files:**
- Modify: `plugins/llm-slash-commands/index.ts` (replace placeholder body)

`setup(ctx)` performs the full plugin lifecycle in one pass (kaizen plugins compose `register/start` into `setup`):

1. Create the registry.
2. Register built-ins.
3. Build fs facade and call `loadFileCommands`. Emit a single startup `conversation:system-message` summarizing warnings (if any).
4. Define + provide the `slash:registry` service.
5. Subscribe to `input:submit` at priority 100 with `makeOnInputSubmit`.
6. If `tui:completion` is provided, register the completion source.

The plugin owns no separate `start`/`stop`. Subscriptions returned by `ctx.subscribe` are tracked and called on shutdown via `ctx.onShutdown` (or equivalent — match the pattern used by `openai-llm`/`llm-events`).

- [ ] **Step 1: Replace `index.ts`**

```ts
import type { KaizenPlugin } from "kaizen/types";
import { readdir, readFile } from "node:fs/promises";
import { createRegistry, type SlashRegistryService } from "./registry.ts";
import { registerBuiltins } from "./builtins.ts";
import { loadFileCommands, type DriverLike } from "./file-loader.ts";
import { makeOnInputSubmit } from "./dispatcher.ts";
import { buildCompletionSource } from "./completion.ts";

interface TuiCompletionService {
  register(source: { trigger: string; list(input: string, cursor: number): Promise<unknown[]> }): () => void;
}

const plugin: KaizenPlugin = {
  name: "llm-slash-commands",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["slash:registry"] },

  async setup(ctx) {
    const registry: SlashRegistryService = createRegistry();

    // Built-ins.
    registerBuiltins(registry);

    // File commands.
    const home = process.env.HOME ?? "/";
    const cwd = process.cwd();
    const warnings = await loadFileCommands({
      home,
      cwd,
      registry,
      readDir: (p) => readdir(p),
      readFile: (p) => readFile(p, "utf8"),
      getDriver: () => ctx.useService?.<DriverLike>("driver:run-conversation") ?? undefined,
    });
    if (warnings.length) {
      const text = "llm-slash-commands: file loader warnings\n" + warnings.map((w) => `  - ${w}`).join("\n");
      await ctx.emit("conversation:system-message", {
        message: { role: "system", content: text },
      });
    }

    // Service.
    ctx.defineService("slash:registry", { description: "Slash command registry." });
    ctx.provideService<SlashRegistryService>("slash:registry", registry);

    // Event subscription. Build a per-handler bus that exposes the cancellation
    // signal and the harness emit. The signal is the session-level signal if
    // available; otherwise an unaborted dummy.
    const sessionSignal: AbortSignal = (ctx as any).signal ?? new AbortController().signal;
    const onSubmit = makeOnInputSubmit({
      registry,
      bus: { emit: (e, p) => ctx.emit(e, p), signal: sessionSignal },
    });
    ctx.on?.("input:submit", onSubmit, { priority: 100 });

    // Optional tui:completion.
    const completion = ctx.useService?.<TuiCompletionService>("tui:completion");
    if (completion) {
      completion.register(buildCompletionSource(registry) as any);
    }
  },
};

export default plugin;
```

- [ ] **Step 2: Run plugin metadata sanity check**

Run: `bun -e "import('./plugins/llm-slash-commands/index.ts').then(m => console.log(JSON.stringify({ name: m.default.name, perm: m.default.permissions, provides: m.default.services?.provides })))"`
Expected: `{"name":"llm-slash-commands","perm":{"tier":"trusted"},"provides":["slash:registry"]}`.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-slash-commands/index.ts
git commit -m "feat(llm-slash-commands): wire setup, registry service, and input:submit subscription"
```

---

## Task 11: `public.d.ts` — re-export public types (Tier 1C)

**Files:**
- Modify: `plugins/llm-slash-commands/public.d.ts`

Other plugins consume `slash:registry` via this module's public types. Spec 0 reserves `SlashRegistryService` etc. as the canonical names; this module is the import site.

- [ ] **Step 1: Replace `public.d.ts`**

```ts
export type {
  SlashCommandContext,
  SlashCommandHandler,
  SlashCommandManifest,
  SlashRegistryService,
  RegistryEntry,
} from "./registry";
export {
  BareNamePluginError,
  ReentrantSlashEmitError,
  DuplicateRegistrationError,
  InvalidNameError,
} from "./errors";
export type { CompletionItem, CompletionSource } from "./completion";
```

- [ ] **Step 2: Type-check**

Run: `bun --bun tsc --noEmit -p plugins/llm-slash-commands/tsconfig.json plugins/llm-slash-commands/index.ts plugins/llm-slash-commands/public.d.ts`
Expected: no diagnostics.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-slash-commands/public.d.ts
git commit -m "feat(llm-slash-commands): public type surface"
```

---

## Task 12: Integration test + fixtures (Tier 1C)

**Files:**
- Create: `plugins/llm-slash-commands/test/fixtures/commands-user/echo.md`
- Create: `plugins/llm-slash-commands/test/fixtures/commands-project/echo.md`
- Create: `plugins/llm-slash-commands/test/fixtures/commands-project/required-args.md`
- Create: `plugins/llm-slash-commands/test/fixtures/commands-user/help.md`
- Create: `plugins/llm-slash-commands/test/fixtures/commands-user/bad-frontmatter.md`
- Create: `plugins/llm-slash-commands/test/integration.test.ts`

The integration test exercises `setup` end-to-end with a stub `ctx`: verifies built-ins registered, file commands loaded, project shadows user, reserved-name file is rejected with a warning emitted as a system message, and the `input:submit` subscription dispatches a file command which emits `conversation:user-message` and calls `runConversation`.

- [ ] **Step 1: Write fixture files**

`plugins/llm-slash-commands/test/fixtures/commands-user/echo.md`:

```markdown
---
description: User echo
---
USER:{{args}}
```

`plugins/llm-slash-commands/test/fixtures/commands-project/echo.md`:

```markdown
---
description: Project echo
usage: "<text>"
---
PROJECT:{{args}}
```

`plugins/llm-slash-commands/test/fixtures/commands-project/required-args.md`:

```markdown
---
description: Needs args
usage: "<text>"
arguments:
  required: true
---
GOT:{{args}}
```

`plugins/llm-slash-commands/test/fixtures/commands-user/help.md`:

```markdown
---
description: Bad — collides with built-in /help
---
should never load
```

`plugins/llm-slash-commands/test/fixtures/commands-user/bad-frontmatter.md`:

```markdown
no frontmatter at all
```

- [ ] **Step 2: Write the integration test**

`plugins/llm-slash-commands/test/integration.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import { join } from "node:path";
import plugin from "../index.ts";

const FIX = join(import.meta.dir, "fixtures");

function makeCtx(opts: { driver?: any; tuiCompletion?: any } = {}) {
  const subs: Record<string, { fn: any; priority: number }[]> = {};
  const services: Record<string, unknown> = {};
  const emits: { event: string; payload: unknown }[] = [];
  const ctx: any = {
    log: () => {},
    config: {},
    signal: new AbortController().signal,
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { services[name] = impl; }),
    useService: mock(<T,>(name: string): T | undefined => {
      if (name === "driver:run-conversation") return opts.driver as T | undefined;
      if (name === "tui:completion") return opts.tuiCompletion as T | undefined;
      return undefined;
    }),
    on: mock((event: string, fn: any, o?: { priority?: number }) => {
      (subs[event] ??= []).push({ fn, priority: o?.priority ?? 0 });
    }),
    emit: mock(async (event: string, payload: unknown) => {
      emits.push({ event, payload });
      // Drive subscribers synchronously for test purposes.
      for (const s of (subs[event] ?? []).sort((a, b) => b.priority - a.priority)) {
        await s.fn(payload);
      }
    }),
  };
  return { ctx, services, emits, subs };
}

describe("llm-slash-commands integration", () => {
  it("setup loads built-ins, file commands, and provides slash:registry; project shadows user; reserved-name file warning surfaced", async () => {
    const origHome = process.env.HOME, origCwd = process.cwd();
    process.env.HOME = join(FIX, "..", "fixtures-home-shim"); // not used; override readdir below if needed
    // We can't easily relocate process.cwd in a unit test, so we override the loader's reads
    // by pointing HOME and cwd at our fixture roots via a per-test tweak: place commands under
    // <FIX>/.kaizen/commands, etc. Restructure fixtures to satisfy that — see below.
    // For this test, cd into the fixtures dir which contains a `.kaizen/commands/` tree.

    // Simpler: spawn-style — set HOME to FIX/user-home and cwd to FIX/project-home where each
    // contains a `.kaizen/commands/` subdir. Adjust fixtures path to match this layout.
    process.env.HOME = join(FIX, "user-home");
    process.chdir(join(FIX, "project-home"));

    const { ctx, services, emits } = makeCtx();
    await plugin.setup(ctx);

    // Service provided.
    expect((services["slash:registry"] as any).list().map((m: any) => m.name).sort()).toEqual(
      ["echo", "exit", "help", "required-args"].sort(),
    );

    // Project shadowed user echo.
    const echo = (services["slash:registry"] as any).get("echo");
    expect(echo.manifest.description).toBe("Project echo");

    // Reserved-name (help.md) and bad-frontmatter file warnings surfaced as a system message.
    const sys = emits.find((e) => e.event === "conversation:system-message");
    expect(sys).toBeDefined();
    const text = (sys!.payload as any).message.content as string;
    expect(text).toMatch(/help\.md/);
    expect(text).toMatch(/bad-frontmatter\.md/);

    process.env.HOME = origHome;
    process.chdir(origCwd);
  });

  it("dispatches /echo via input:submit, emits conversation:user-message and calls runConversation", async () => {
    const origHome = process.env.HOME, origCwd = process.cwd();
    process.env.HOME = join(FIX, "user-home");
    process.chdir(join(FIX, "project-home"));

    const runConversation = mock(async () => ({ finalMessage: { role: "assistant", content: "" }, messages: [], usage: { promptTokens: 0, completionTokens: 0 } }));
    const driver = { runConversation };
    const { ctx, emits } = makeCtx({ driver });
    await plugin.setup(ctx);

    await ctx.emit("input:submit", { text: "/echo hello world" });

    const userMsg = emits.find((e) => e.event === "conversation:user-message");
    expect(userMsg).toBeDefined();
    expect((userMsg!.payload as any).message.content).toBe("PROJECT:hello world\n");
    expect(runConversation).toHaveBeenCalledTimes(1);

    const handled = emits.find((e) => e.event === "input:handled");
    expect(handled?.payload).toEqual({ by: "llm-slash-commands" });

    process.env.HOME = origHome;
    process.chdir(origCwd);
  });

  it("required-args validation: empty args prints usage and does not run conversation", async () => {
    const origHome = process.env.HOME, origCwd = process.cwd();
    process.env.HOME = join(FIX, "user-home");
    process.chdir(join(FIX, "project-home"));

    const runConversation = mock(async () => ({} as any));
    const { ctx, emits } = makeCtx({ driver: { runConversation } });
    await plugin.setup(ctx);

    await ctx.emit("input:submit", { text: "/required-args" });

    expect(runConversation).not.toHaveBeenCalled();
    const sys = emits.filter((e) => e.event === "conversation:system-message").map((e: any) => e.payload.message.content).join("\n");
    expect(sys).toMatch(/requires arguments/);
    expect(sys).toMatch(/<text>/);

    process.env.HOME = origHome;
    process.chdir(origCwd);
  });

  it("registers a tui:completion source when present", async () => {
    const origHome = process.env.HOME, origCwd = process.cwd();
    process.env.HOME = join(FIX, "user-home");
    process.chdir(join(FIX, "project-home"));

    const tuiSources: any[] = [];
    const tui = { register: (s: any) => { tuiSources.push(s); return () => {}; } };
    const { ctx } = makeCtx({ tuiCompletion: tui });
    await plugin.setup(ctx);

    expect(tuiSources.length).toBe(1);
    expect(tuiSources[0]!.trigger).toBe("/");
    const items = await tuiSources[0]!.list("/he", 3);
    expect(items.find((i: any) => i.label === "/help")).toBeDefined();

    process.env.HOME = origHome;
    process.chdir(origCwd);
  });
});
```

- [ ] **Step 3: Restructure fixtures so the test layout matches**

Move/copy the fixture files into the layout the test expects:

```
plugins/llm-slash-commands/test/fixtures/
  user-home/
    .kaizen/commands/
      echo.md           # description: User echo, body: USER:{{args}}
      help.md           # reserved-name collision file
      bad-frontmatter.md
  project-home/
    .kaizen/commands/
      echo.md           # description: Project echo, body: PROJECT:{{args}}
      required-args.md  # arguments.required: true
```

Run:

```bash
mkdir -p plugins/llm-slash-commands/test/fixtures/user-home/.kaizen/commands
mkdir -p plugins/llm-slash-commands/test/fixtures/project-home/.kaizen/commands
mv plugins/llm-slash-commands/test/fixtures/commands-user/echo.md          plugins/llm-slash-commands/test/fixtures/user-home/.kaizen/commands/echo.md
mv plugins/llm-slash-commands/test/fixtures/commands-user/help.md          plugins/llm-slash-commands/test/fixtures/user-home/.kaizen/commands/help.md
mv plugins/llm-slash-commands/test/fixtures/commands-user/bad-frontmatter.md plugins/llm-slash-commands/test/fixtures/user-home/.kaizen/commands/bad-frontmatter.md
mv plugins/llm-slash-commands/test/fixtures/commands-project/echo.md       plugins/llm-slash-commands/test/fixtures/project-home/.kaizen/commands/echo.md
mv plugins/llm-slash-commands/test/fixtures/commands-project/required-args.md plugins/llm-slash-commands/test/fixtures/project-home/.kaizen/commands/required-args.md
rmdir plugins/llm-slash-commands/test/fixtures/commands-user plugins/llm-slash-commands/test/fixtures/commands-project
```

- [ ] **Step 4: Run integration test**

Run: `bun test plugins/llm-slash-commands/test/integration.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Run full plugin test sweep**

Run: `bun test plugins/llm-slash-commands/`
Expected: all tests PASS (parser 13 + errors 4 + registry 13 + frontmatter 6 + builtins 5 + file-loader 7 + completion 5 + dispatcher 7 + integration 4 = 64).

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-slash-commands/test/fixtures plugins/llm-slash-commands/test/integration.test.ts
git commit -m "test(llm-slash-commands): integration test + fixture command tree"
```

---

## Task 13: Marketplace catalog update

**Files:**
- Modify: `.kaizen/marketplace.json`

- [ ] **Step 1: Add the entry**

Insert this entry after the existing `openai-llm` entry, before the `claude-wrapper` harness entry:

```jsonc
    {
      "kind": "plugin",
      "name": "llm-slash-commands",
      "description": "Slash command registry, dispatcher, and file loader for the openai-compatible harness.",
      "categories": ["slash", "commands"],
      "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-slash-commands" } }]
    },
```

- [ ] **Step 2: Validate JSON**

Run: `bun -e "JSON.parse(require('node:fs').readFileSync('.kaizen/marketplace.json','utf8'))"`
Expected: no error.

- [ ] **Step 3: Final test sweep**

Run: `bun test plugins/llm-slash-commands`
Expected: all PASS (64).

- [ ] **Step 4: Commit**

```bash
git add .kaizen/marketplace.json
git commit -m "chore(marketplace): publish llm-slash-commands@0.1.0"
```

---

## Spec coverage summary

| Spec section | Task |
|---|---|
| Spec 0 contract additions (`slash:registry` types) | Task 11 (re-export); registry/dispatcher/types defined Tasks 4, 9 |
| Parser rules (start `/`, `[a-z]…`, args after first space) | Task 2 |
| Registry (register/get/list, duplicate throws, unregister) | Task 4 |
| Bare-name reservation enforcement (BareNamePluginError on `source: "plugin"` + bare name) | Task 4 (unit), Task 12 (integration) |
| Built-ins `/help` (grouped by source) and `/exit` (emits `session:end`) | Task 6 |
| File loader: discovery, project-shadows-user, reserved-name rejection, malformed-frontmatter warning, missing dirs tolerated | Task 7, Task 12 |
| `{{args}}` substitution + `arguments.required` validation | Task 7, Task 12 |
| Re-entrancy / loop prevention (wrapped emit rejects `input:submit`, `inSlashDispatch` flag) | Task 9 |
| Unknown-command system message + `input:handled` claim | Task 9 |
| `tui:completion` consumption (registers source if service present, no-ops otherwise) | Task 8, Task 10, Task 12 |
| Lifecycle: `setup` builds registry, registers built-ins, loads files, provides service, subscribes at priority 100, registers completion source | Task 10 |
| Permissions: `tier: "trusted"` | Task 1, Task 10 |
| Marketplace catalog | Task 13 |

## Self-review notes (applied)

- The bare-name rule is enforced in `registry.register` (Task 4) and tested both in unit tests (5 cases under "bare-name enforcement") and end-to-end via Task 12. A plugin attempting `register({ source: "plugin", name: "foo" }, h)` throws `BareNamePluginError` — this is the load-bearing spec rule and is guarded explicitly.
- File-loaded commands and built-ins are exempt from the bare-name rule — verified by test cases `source=builtin + bare name succeeds` and `source=file + bare name succeeds`.
- Reserved-name file collision (`help.md`) is caught at load time and surfaces as a startup warning via `conversation:system-message` (Task 7 unit test, Task 12 integration test).
- Re-entrancy: `ctx.emit("input:submit", …)` from inside a handler throws `ReentrantSlashEmitError`, surfaced as `session:error`. The `inSlashDispatch` flag is a defense-in-depth secondary guard (Task 9 unit test).
- `input:handled` is emitted exactly once per matched dispatch — including unknown-command and handler-throws paths — and never on parse miss (Task 9 unit test).
- Priority 100 subscription on `input:submit` matches Spec 0 / Spec 10 priority bands.
- The `{{args}}` substitution is a literal `String#split.join` to support multiple occurrences and avoid regex escape issues with arbitrary user args (Task 7).
- `tui:completion` consumption is optional: the plugin no-ops if the service is absent (Task 10, integration test 4).
- All shared types (`ChatMessage`-bearing event payloads) come from `llm-events/public`; this plugin defines its own types only for the slash-specific surface.
