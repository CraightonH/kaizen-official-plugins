import type { SlashRegistryService, SlashCommandManifest } from "./registry.ts";
import type { CompletionItem, CompletionSource } from "llm-tui/public";

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
          detail: m.description,
        }));
    },
  };
}
