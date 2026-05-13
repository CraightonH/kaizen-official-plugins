import {
  BareNamePluginError,
  DuplicateRegistrationError,
  InvalidNameError,
} from "./errors.ts";
import type {
  SlashCommandContext,
  SlashCommandHandler,
  SlashCommandManifest,
  SlashRegistryEntry,
  RegistryEntry,
  SlashRegistryService,
} from "llm-contracts/public";

export type {
  SlashCommandContext,
  SlashCommandHandler,
  SlashCommandManifest,
  SlashRegistryEntry,
  RegistryEntry,
  SlashRegistryService,
};

const SEGMENT_RE = /^[a-z][a-z0-9-]*$/;

function validateNameShape(name: string): void {
  if (!name) throw new InvalidNameError(name);
  const segments = name.split(":");
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg)) throw new InvalidNameError(name);
  }
}

export function createRegistry(): SlashRegistryService {
  const map = new Map<string, SlashRegistryEntry>();

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
