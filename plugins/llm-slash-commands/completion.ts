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
