import type { UiToolRenderer, UiToolRendererService } from "llm-contracts/public";
import { DEFAULT_CONFIG } from "../config.ts";

export type { UiToolRenderer, UiToolRendererService };
/** @deprecated Use UiToolRenderer from llm-contracts/public */
export type TuiToolRenderer = UiToolRenderer;
/** @deprecated Use UiToolRendererService from llm-contracts/public */
export type TuiToolRendererService = UiToolRendererService;

export interface ToolRendererRegistry {
  service: UiToolRendererService;
  lookup(toolName: string): UiToolRenderer | undefined;
}

export interface ToolRendererRegistryOptions {
  /**
   * Byte cap for the JSON dump used when no renderer is registered for a
   * tool name. Falls back to `LlmTuiConfig.toolFallbackJsonChars` default.
   */
  getFallbackJsonChars?: () => number;
}

export function makeToolRendererRegistry(opts: ToolRendererRegistryOptions = {}): ToolRendererRegistry {
  const byName = new Map<string, UiToolRenderer>();
  const getFallbackJsonChars =
    opts.getFallbackJsonChars ?? (() => DEFAULT_CONFIG.toolFallbackJsonChars);

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
    const maxLen = getFallbackJsonChars();
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
