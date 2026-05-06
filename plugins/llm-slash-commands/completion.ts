import type { SlashRegistryService, SlashCommandManifest } from "./registry.ts";

export interface CompletionItem {
  label: string;
  insertText: string;
  description?: string;
}

// Matches the llm-tui CompletionSource contract: id + trigger + list(query),
// where `query` is the text typed AFTER the trigger char (no leading "/").
export interface CompletionSource {
  id: string;
  trigger: string;
  list(query: string): Promise<CompletionItem[]>;
}

function rank(m: SlashCommandManifest): number {
  if (m.source === "builtin" && !m.name.includes(":")) return 0;
  if (m.source === "file") return 1;
  return 2;
}

export function buildCompletionSource(registry: SlashRegistryService): CompletionSource {
  return {
    id: "llm-slash-commands:registry",
    trigger: "/",
    async list(query: string): Promise<CompletionItem[]> {
      const all = registry.list();
      return all
        .filter((m) => m.name.startsWith(query))
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
