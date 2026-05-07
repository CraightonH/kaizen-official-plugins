import type { ReactNode } from "react";
import type { ToolCallStatus } from "../state/store.ts";

export interface TuiToolRenderer {
  toolName: string;
  collapsedSummary: (args: unknown) => string;
  expandedView: (args: unknown, result: string | undefined, status: ToolCallStatus, stdout: string) => ReactNode;
}

export interface TuiToolRendererService {
  register(renderer: TuiToolRenderer): () => void;
}

export interface ToolRendererRegistry {
  service: TuiToolRendererService;
  lookup(toolName: string): TuiToolRenderer | undefined;
}

export function makeToolRendererRegistry(): ToolRendererRegistry {
  const byName = new Map<string, TuiToolRenderer>();
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
