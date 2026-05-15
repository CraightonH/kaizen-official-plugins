import type { UiToolRenderer, UiToolRendererService } from "llm-contracts/public";

export type { UiToolRenderer, UiToolRendererService };
/** @deprecated Use UiToolRenderer from llm-contracts/public */
export type TuiToolRenderer = UiToolRenderer;
/** @deprecated Use UiToolRendererService from llm-contracts/public */
export type TuiToolRendererService = UiToolRendererService;

export interface ToolRendererRegistry {
  service: UiToolRendererService;
  lookup(toolName: string): UiToolRenderer | undefined;
}

export function makeToolRendererRegistry(): ToolRendererRegistry {
  const byName = new Map<string, UiToolRenderer>();

  function summarize(name: string, args: unknown): string {
    const renderer = byName.get(name);
    if (renderer) {
      try {
        return renderer.collapsedSummary(args);
      } catch {
        // fall through to JSON fallback
      }
    }
    let json: string;
    try {
      json = JSON.stringify(args, null, 2);
    } catch {
      json = String(args);
    }
    const maxLen = 1500;
    if (json.length <= maxLen) return `${name}\n${json}`;
    const truncated = json.slice(0, maxLen);
    return `${name}\n${truncated}… (${json.length - maxLen} more chars)`;
  }

  return {
    service: {
      register(renderer) {
        byName.set(renderer.toolName, renderer);
        return () => {
          if (byName.get(renderer.toolName) === renderer) byName.delete(renderer.toolName);
        };
      },
      summarize,
    },
    lookup(toolName) {
      return byName.get(toolName);
    },
  };
}
