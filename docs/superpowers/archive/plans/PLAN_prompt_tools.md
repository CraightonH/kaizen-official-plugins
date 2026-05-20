# Plan: Expose `prompt:*` slash commands as tools

## Goal

Register four LLM-callable tools — `prompt_show`, `prompt_reload`, `prompt_disable`, `prompt_enable` — alongside the existing slash commands in `plugins/llm-system-prompt`. These give the agent (best-effort) read/manage access to the assembled system prompt.

The slash commands stay unchanged. Tool registration is best-effort: if `tools:registry` isn't in the harness, the plugin still works.

## Constraints (do not violate)

- **Tool names use `_`, not `:`.** OpenAI-compatible providers require `^[a-zA-Z0-9_-]{1,64}$`. Use `prompt_show`, `prompt_reload`, `prompt_disable`, `prompt_enable`.
- **`slash.ts` is not modified.** Don't refactor slash handlers. Tool handlers live in a new `tool.ts` and operate directly on `registry` + `reloadIdentity`.
- **Only `index.ts` touches `ctx`.** Per the plugin's `CLAUDE.md` module map.
- **Best-effort registration.** If `tools:registry` is absent, log and continue — the plugin must still provide `prompt:registry`.
- **All four tools must unregister on `stop()`.** Hot-reload safety. The identity section unregister handle should also be drained.
- **Tag tools `["prompt", "diagnostic", "synthetic"]`.** So harnesses can gate them.

## Reference implementations to mirror

- `plugins/llm-skills/tool.ts` — shape for a co-located `tool.ts` (schema constant + `makeXxxHandler` factory).
- `plugins/llm-skills/index.ts:114-122` — best-effort `useService` → `registerWith` pattern with `source.kind`.
- `plugins/llm-skills/index.ts:125-130` — `stop()` draining unregister callbacks idempotently.
- `plugins/llm-contracts/contracts/tools-registry.ts` — `ToolsRegistryService`, `ToolHandler`, `ToolExecutionContext` types.
- `plugins/llm-contracts/contracts/llm-complete.ts:24` — `ToolSchema` shape.

## Files to change

### 1. New: `plugins/llm-system-prompt/tool.ts`

Pure factory. No `ctx`, no state. Mirrors `llm-skills/tool.ts`.

Exports:

```typescript
import type { ToolSchema } from "llm-contracts/public";
import type { ToolHandler } from "llm-contracts/public";
import type { SystemPromptServiceImpl } from "./registry.ts";

export interface PromptToolOptions {
  registry: SystemPromptServiceImpl;
  reloadIdentity: () => Promise<void>;
}

export interface PromptToolEntry {
  schema: ToolSchema;
  handler: ToolHandler;
}

export function makePromptToolHandlers(opts: PromptToolOptions): {
  show: PromptToolEntry;
  reload: PromptToolEntry;
  disable: PromptToolEntry;
  enable: PromptToolEntry;
};
```

Schemas:

- `prompt_show`
  - description: `"Show the current assembled system prompt. Diagnostic — call only when explicitly asked to inspect the prompt."`
  - parameters: `{ type: "object", properties: { stats: { type: "boolean", description: "Include per-section character counts and the generation counter." } }, additionalProperties: false }`
  - tags: `["prompt", "diagnostic", "synthetic"]`
- `prompt_reload`
  - description: `"Re-read identity files from disk and bump the prompt generation. Has filesystem side effects — do not call speculatively."`
  - parameters: `{ type: "object", properties: {}, additionalProperties: false }`
  - tags: `["prompt", "diagnostic", "synthetic"]`
- `prompt_disable`
  - description: `"Disable a system-prompt section by id. Diagnostic — disabling sections (e.g. 'identity', 'llm-skills:available') changes the agent's own context. Use only when explicitly asked."`
  - parameters: `{ type: "object", properties: { sectionId: { type: "string", description: "ID of the section to disable." } }, required: ["sectionId"], additionalProperties: false }`
  - tags: `["prompt", "diagnostic", "synthetic"]`
- `prompt_enable`
  - description: `"Re-enable a previously-disabled system-prompt section by id."`
  - parameters: `{ type: "object", properties: { sectionId: { type: "string", description: "ID of the section to enable." } }, required: ["sectionId"], additionalProperties: false }`
  - tags: `["prompt", "diagnostic", "synthetic"]`

Handler bodies (logic mirrors `slash.ts` but returns structured data instead of calling `ctx.print`):

- `show` — read optional `stats` boolean (default `false`). Iterate `registry.list().slice().sort((a, b) => a.priority - b.priority)`. For each section, call `await registry.renderSection(s.id)`. Return:
  ```typescript
  {
    generation: number,
    sections: Array<{
      id: string,
      priority: number,
      title?: string,
      body: string | null,   // null when disabled/unknown
      chars?: number,        // only when stats === true
    }>
  }
  ```
- `reload` — `await reloadIdentity()`. Return `{ ok: true, message: "identity reloaded" }`.
- `disable` — validate args is object, `sectionId` is non-empty string. If `!registry.has(sectionId)` throw `Error(\`no section with id "${sectionId}"\`)`. Call `registry.disable(sectionId)`. Return `{ ok: true, sectionId, action: "disabled" }`.
- `enable` — same validation. If `!registry.has(sectionId)` throw. Call `registry.enable(sectionId)`. Return `{ ok: true, sectionId, action: "enabled" }`.

Argument validation pattern (copy from `llm-skills/tool.ts:26-32`):

```typescript
if (typeof args !== "object" || args === null) {
  throw new Error("prompt_disable: args must be an object with a 'sectionId' string");
}
const sectionId = (args as { sectionId?: unknown }).sectionId;
if (typeof sectionId !== "string" || sectionId.length === 0) {
  throw new Error("prompt_disable: 'sectionId' is required and must be a non-empty string");
}
```

### 2. Edit: `plugins/llm-system-prompt/index.ts`

Changes:

- Add `import { makePromptToolHandlers } from "./tool.ts";`
- Add `import type { ToolsRegistryService } from "llm-contracts/public";`
- Add `"tools:registry"` to `services.consumes` (topo hint — keep `events:vocabulary` first):
  ```typescript
  services: {
    provides: ["prompt:registry"],
    consumes: ["events:vocabulary", "tools:registry"],
  },
  ```
- Track unregister callbacks in a module-scope `let`:
  ```typescript
  let identityHandle: RegisteredSection | undefined;
  let toolUnregisters: Array<() => void> = [];
  ```
  Move `identityHandle` out of `setup()` to module scope so `stop()` can reach it. (Keep the local assignment in setup; just declare at module scope.)
- After the slash registration block, add tool registration:
  ```typescript
  const toolsRegistry = safeUseService<ToolsRegistryService>(ctx, "tools:registry");
  if (toolsRegistry) {
    const reloadIdentity = async () => {
      await identity.reload();
      identityHandle!.bumpGeneration();
      await ctx.emit(vocab.PROMPT_RELOAD, {});
    };
    const tools = makePromptToolHandlers({ registry, reloadIdentity });
    for (const entry of [tools.show, tools.reload, tools.disable, tools.enable]) {
      toolUnregisters.push(
        toolsRegistry.registerWith({
          schema: entry.schema,
          handler: entry.handler,
          source: { kind: "prompt" },
        }),
      );
    }
  } else {
    ctx.log?.("[llm-system-prompt] tools:registry not available; prompt_* tools not registered");
  }
  ```
  Note: the `reloadIdentity` closure is duplicated with the one passed to `makePromptSlashHandlers`. Extract it once near the top of setup and pass the same reference to both factories:
  ```typescript
  const reloadIdentity = async () => {
    await identity.reload();
    identityHandle.bumpGeneration();
    await ctx.emit(vocab.PROMPT_RELOAD, {});
  };
  ```
  Define it after `identityHandle` is assigned. Pass `{ registry, reloadIdentity }` to both `makePromptSlashHandlers` and `makePromptToolHandlers`.
- Add a `stop()` hook (sibling of `setup`):
  ```typescript
  async stop() {
    for (const u of toolUnregisters) {
      try { u(); } catch { /* idempotent */ }
    }
    toolUnregisters = [];
    try { identityHandle?.unregister(); } catch { /* idempotent */ }
    identityHandle = undefined;
  },
  ```

`safeUseService` already exists in this file — reuse it.

### 3. Edit: `plugins/llm-system-prompt/package.json`

Bump `version` from `"0.1.0"` to `"0.2.0"` (public surface change).

### 4. New: `plugins/llm-system-prompt/test/tool.test.ts`

Unit tests for the tool factory in isolation (no `ctx`, no plugin lifecycle). Mirror the style of `slash.test.ts` if present, otherwise use this shape:

```typescript
import { describe, expect, it } from "bun:test";
import { createRegistry } from "../registry.ts";
import { makePromptToolHandlers } from "../tool.ts";

function makeFixture() {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const registry = createRegistry({
    events: { promptRebuilt: "prompt:rebuilt" },
    emit: async (event, payload) => { emitted.push({ event, payload }); },
  });
  let reloaded = 0;
  const reloadIdentity = async () => { reloaded++; };
  const tools = makePromptToolHandlers({ registry, reloadIdentity });
  return { registry, tools, emitted, reloaded: () => reloaded };
}

const fakeToolCtx = {
  signal: new AbortController().signal,
  callId: "test",
  log: () => {},
};
```

Required cases:

- `prompt_show` returns sections sorted by priority, with `body: null` for disabled sections.
- `prompt_show` with `{ stats: true }` populates `chars` and includes `generation`.
- `prompt_reload` invokes `reloadIdentity` and returns `{ ok: true, message: "identity reloaded" }`.
- `prompt_disable` with non-existent id throws `no section with id "..."`.
- `prompt_disable` with missing/empty `sectionId` throws the validation error.
- `prompt_disable` followed by `prompt_enable` round-trips (section is back in `registry.list()` with `disabled: false`, or `renderSection` returns the body again).
- Schemas have correct names (`prompt_show` etc., with underscores), correct `additionalProperties: false`, and `tags` include `"prompt"`, `"diagnostic"`, `"synthetic"`.

### 5. Edit: `plugins/llm-system-prompt/test/index.test.ts`

Extend `makeFakeCtx` to support a fake `tools:registry`:

- Add an `opts.tools?: boolean` parameter (default `true`).
- Add a `toolRegistrations: Array<{ schema: ToolSchema; source: { kind: string; [k: string]: unknown } }>` collector.
- Add a fake `toolsRegistry` exposing `register`, `registerWith` (push to the collector and return a no-op unregister), `list`, `listRegistrations`, `invoke`. Only `registerWith` is exercised, but the type surface must match `ToolsRegistryService` so cast-as-any works.
- In `useService`, return the fake when `n === "tools:registry" && tools`.

Add tests:

- `setup registers prompt_show, prompt_reload, prompt_disable, prompt_enable on tools:registry` — assert all four names present (with underscores) and `source.kind === "prompt"`.
- `setup does not register tools when tools:registry is absent` — invoke with `{ tools: false }`, assert `toolRegistrations` is empty, `prompt:registry` is still provided, slash commands still registered.
- `stop() unregisters all tools and the identity section` — call `plugin.stop!()`, assert the unregister callbacks ran (verify by tracking calls in the fake).

### 6. Local deploy (run after edits)

The runtime prefers `dist/index.js`. After changes:

```sh
cd plugins/llm-system-prompt
bun build --target=bun --outfile=dist/index.js index.ts
VERSION=$(jq -r .version package.json)   # 0.2.0
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/llm-system-prompt@${VERSION}
mkdir -p "$INSTALL_DIR/dist"
rsync -a --exclude=node_modules --exclude=dist ./ "$INSTALL_DIR/"
cp dist/index.js "$INSTALL_DIR/dist/index.js"
```

If `~/.kaizen/marketplaces/official/plugins/llm-system-prompt@0.1.0/` exists from a prior install, leave it alone — the version bump means the new dir is `@0.2.0`. The harness manifest (`harnesses/openai-compatible.json`) may need its pin updated to `0.2.0` — check before running.

## Verification

Run from repo root:

```sh
cd plugins/llm-system-prompt && bun test
```

All existing tests must still pass. New tests must pass. Also:

```sh
kaizen plugin validate plugins/llm-system-prompt
```

Then end-to-end:

```sh
kaizen --harness ./harnesses/openai-compatible.json
```

In the TUI, ask the agent "what tools do you have?" — it should list `prompt_show`, `prompt_reload`, `prompt_disable`, `prompt_enable` among the others. Run `/prompt:show` to confirm slash commands still work unchanged.

## Out of scope

- Filtering `prompt_show` by section id.
- Changing slash command behavior or output.
- Changing the prompt assembly logic in `registry.ts` or `identity.ts`.
- Adding `prompt_*` tools to the prompt's "Available tools" section text (that section is built by `llm-driver` from the registry — it'll pick them up automatically).
- Harness-level gating of diagnostic tools (the tags are added to enable this later; no policy is added now).

## Acceptance checklist

- [ ] `plugins/llm-system-prompt/tool.ts` exists, exports `makePromptToolHandlers`, no `ctx` import, no `kaizen/types` import.
- [ ] `slash.ts` is byte-identical to before this change.
- [ ] All four tool names use `_`, never `:`.
- [ ] All four schemas have `additionalProperties: false` and tags `["prompt", "diagnostic", "synthetic"]`.
- [ ] `index.ts` adds `"tools:registry"` to `services.consumes`.
- [ ] `index.ts` defines `reloadIdentity` once and passes the same reference to both factories.
- [ ] `index.ts` has a `stop()` hook that drains tool unregisters and the identity-section unregister, both idempotent.
- [ ] Tools register via `registerWith` with `source: { kind: "prompt" }`.
- [ ] `package.json` version is `0.2.0`.
- [ ] `tool.test.ts` covers the cases listed above.
- [ ] `index.test.ts` covers presence + absence of `tools:registry` and `stop()` cleanup.
- [ ] `bun test` passes in `plugins/llm-system-prompt`.
- [ ] `kaizen plugin validate plugins/llm-system-prompt` passes.
- [ ] `dist/index.js` rebuilt and synced to `~/.kaizen/marketplaces/official/plugins/llm-system-prompt@0.2.0/`.
