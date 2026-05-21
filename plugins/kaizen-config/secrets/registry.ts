import type { SecretRef, SecretsRegistryService, SecretsResolver } from "llm-contracts/public";

export function createRegistry(): SecretsRegistryService {
  const resolvers = new Map<string, SecretsResolver>();

  const parseRef = (ref: SecretRef): { scheme: string; key: string } => {
    const idx = ref.$ref.indexOf(":");
    if (idx <= 0) throw new Error(`malformed $ref: '${ref.$ref}' (expected 'scheme:key')`);
    return { scheme: ref.$ref.slice(0, idx), key: ref.$ref.slice(idx + 1) };
  };

  return {
    register(resolver) {
      if (resolvers.has(resolver.scheme)) {
        throw new Error(`secrets:registry: scheme '${resolver.scheme}' already registered`);
      }
      resolvers.set(resolver.scheme, resolver);
      return () => { resolvers.delete(resolver.scheme); };
    },
    async resolve(ref) {
      const { scheme, key } = parseRef(ref);
      const r = resolvers.get(scheme);
      if (!r) throw new Error(`secrets:registry: no resolver registered for scheme '${scheme}'`);
      return r.get(key);
    },
    async store(scheme, key, value) {
      const r = resolvers.get(scheme);
      if (!r) throw new Error(`secrets:registry: no resolver registered for scheme '${scheme}'`);
      if (r.readOnly || !r.set) throw new Error(`secrets:registry: scheme '${scheme}' is read-only`);
      await r.set(key, value);
      return { $ref: `${scheme}:${key}` };
    },
    async delete(ref) {
      const { scheme, key } = parseRef(ref);
      const r = resolvers.get(scheme);
      if (!r) return;
      if (r.readOnly || !r.delete) throw new Error(`secrets:registry: scheme '${scheme}' is read-only`);
      try { await r.delete(key); }
      catch { /* already gone */ }
    },
    schemes() {
      return [...resolvers.keys()];
    },
    readOnlySchemes() {
      const out: string[] = [];
      for (const [scheme, r] of resolvers) {
        if (r.readOnly) out.push(scheme);
      }
      return out;
    },
    has(scheme) {
      return resolvers.has(scheme);
    },
  };
}
