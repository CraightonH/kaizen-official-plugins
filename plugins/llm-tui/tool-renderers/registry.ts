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
  return {
    service: {
      register(renderer) {
        byName.set(renderer.toolName, renderer);
        return () => {
          if (byName.get(renderer.toolName) === renderer) byName.delete(renderer.toolName);
        };
      },
    },
    lookup(toolName) {
      return byName.get(toolName);
    },
  };
}
