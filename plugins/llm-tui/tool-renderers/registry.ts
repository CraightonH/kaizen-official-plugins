import type { ReactNode } from "react";
import type { ToolCallStatus } from "../state/store.ts";

export interface TuiToolRenderer {
  toolName: string;
  collapsedSummary: (args: unknown) => string;
  /**
   * Verbose result view rendered inline below the one-line tool summary
   * after the call finalizes (status `done` or `error`). Returning null
   * keeps the output to the one-liner only. The view is only consulted
   * for terminal states; running calls always show the spinner line.
   */
  expandedView?: (args: unknown, result: string | undefined, status: ToolCallStatus, stdout: string) => ReactNode | null;
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
