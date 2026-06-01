import type { WorkflowManifest, WorkflowRegistryService, RunOptions, RunResult } from "llm-contracts/public";

export interface Registry {
  service: Pick<WorkflowRegistryService, "list" | "get" | "register">;
}

/**
 * Build an in-memory registry around a fixed initial manifest set.
 * `runInline` / `runByName` live in `engine.ts` — this module owns naming + list/get/register only.
 */
export function makeRegistry(initial: WorkflowManifest[], onChange?: () => void): Registry {
  const map = new Map<string, WorkflowManifest>();
  for (const m of initial) map.set(m.meta.name, m);

  const service: Pick<WorkflowRegistryService, "list" | "get" | "register"> = {
    list() { return [...map.values()]; },
    get(name) { return map.get(name); },
    register(manifest: WorkflowManifest) {
      const name = manifest.meta.name;
      if (!name.startsWith("runtime:")) {
        throw new Error(`workflow:registry.register requires names with 'runtime:' prefix; got '${name}'`);
      }
      if (map.has(name)) {
        throw new Error(`workflow:registry: name '${name}' already registered`);
      }
      map.set(name, { ...manifest, scope: manifest.scope ?? "runtime", sourcePath: manifest.sourcePath ?? "<runtime>" });
      onChange?.();
      return () => { map.delete(name); onChange?.(); };
    },
  };

  return { service };
}

export interface RegistryHandle {
  service: Pick<WorkflowRegistryService, "list" | "get" | "register">;
  setInner(next: Registry, onChange?: () => void): void;
}

export function makeRegistryHandle(initial: Registry): RegistryHandle {
  let inner = initial;
  return {
    get service() {
      return {
        list: () => inner.service.list(),
        get: (n: string) => inner.service.get(n),
        register: (m: WorkflowManifest) => inner.service.register(m),
      };
    },
    setInner(next, onChange) { inner = next; onChange?.(); },
  };
}

// Re-export for runner.ts / engine.ts convenience.
export type { WorkflowManifest, WorkflowRegistryService, RunOptions, RunResult };
