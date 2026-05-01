import type { AgentManifest, AgentsRegistryService } from "llm-events/public";
import type { InternalAgentManifest } from "./frontmatter.ts";

export interface AgentsRegistry {
  service: AgentsRegistryService;
  getInternal(name: string): InternalAgentManifest | undefined;
}

export function makeRegistry(initial: InternalAgentManifest[]): AgentsRegistry {
  const map = new Map<string, InternalAgentManifest>();
  for (const m of initial) map.set(m.name, m);

  function publicView(m: InternalAgentManifest): AgentManifest {
    const { sourcePath, scope, modelOverride, ...rest } = m;
    return rest;
  }

  const service: AgentsRegistryService = {
    list(): AgentManifest[] {
      return [...map.values()].map(publicView);
    },
    register(manifest: AgentManifest): () => void {
      if (!manifest.name.startsWith("runtime:")) {
        throw new Error(`agents:registry.register requires names with 'runtime:' prefix; got '${manifest.name}'`);
      }
      if (map.has(manifest.name)) {
        throw new Error(`agents:registry: name '${manifest.name}' already registered`);
      }
      const internal: InternalAgentManifest = {
        ...manifest,
        sourcePath: "<runtime>",
        scope: "user",
      };
      map.set(manifest.name, internal);
      return () => { map.delete(manifest.name); };
    },
  };

  return {
    service,
    getInternal(name: string) { return map.get(name); },
  };
}

export interface RegistryHandle {
  service: AgentsRegistryService;
  getInternal(name: string): InternalAgentManifest | undefined;
  setInner(next: AgentsRegistry): void;
}

export function makeRegistryHandle(initial: AgentsRegistry): RegistryHandle {
  let inner = initial;
  return {
    get service() {
      return {
        list: () => inner.service.list(),
        register: (m: AgentManifest) => inner.service.register(m),
      } as AgentsRegistryService;
    },
    getInternal(name) { return inner.getInternal(name); },
    setInner(next) { inner = next; },
  } as RegistryHandle;
}
