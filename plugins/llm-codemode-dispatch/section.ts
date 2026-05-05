/**
 * Factory for the `prompt:system` section that exposes the code-mode API surface.
 *
 * Returns `{ section, attach }`:
 * - `section` — a `SystemPromptSection` (id `llm-codemode-dispatch:api`, priority 100)
 *   with hash-gated render caching.
 * - `attach(onChange)` — subscribes to `tools:registered` / `tools:unregistered` and
 *   calls `onChange()` only when the surface hash actually changes. Returns an `off`
 *   closure that unsubscribes both listeners.
 *
 * The actual `bumpGeneration()` call on the prompt:system handle is performed by
 * index.ts (Task 6); `attach` merely surfaces the hook.
 */

import type { SystemPromptSection } from "llm-system-prompt/public";
import type { ToolsRegistryService } from "llm-tools-registry/public";
import { renderSurface, surfaceHash } from "./assembler.ts";

type OnFn = (event: string, handler: (payload: unknown) => Promise<void>) => () => void;

export interface ApiSurfaceSectionDeps {
  registry: Pick<ToolsRegistryService, "listRegistrations">;
  on: OnFn;
}

export interface ApiSurfaceSectionResult {
  section: SystemPromptSection;
  attach: (onChange: () => void) => () => void;
}

export function makeApiSurfaceSection(deps: ApiSurfaceSectionDeps): ApiSurfaceSectionResult {
  const { registry, on } = deps;

  // Seed the hash from current registry state so the first attach() event with
  // no real change is a no-op (prevents spurious bumps on startup).
  let cachedHash: string = surfaceHash(registry.listRegistrations());
  let cachedRender: string | null = null;

  const section: SystemPromptSection = {
    id: "llm-codemode-dispatch:api",
    priority: 100,

    async render(): Promise<string> {
      const regs = registry.listRegistrations();
      const hash = surfaceHash(regs);
      if (hash === cachedHash && cachedRender !== null) {
        return cachedRender;
      }
      const rendered = await renderSurface(regs);
      cachedHash = hash;
      cachedRender = rendered;
      return rendered;
    },
  };

  function attach(onChange: () => void): () => void {
    async function handleChange(_payload: unknown): Promise<void> {
      const regs = registry.listRegistrations();
      const hash = surfaceHash(regs);
      if (hash === cachedHash) return;
      // Update both caches atomically so a concurrent render() sees the new state.
      cachedHash = hash;
      cachedRender = null;
      onChange();
    }

    const offRegistered = on("tools:registered", handleChange);
    const offUnregistered = on("tools:unregistered", handleChange);

    return () => {
      offRegistered();
      offUnregistered();
    };
  }

  return { section, attach };
}
