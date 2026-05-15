import type { ReactNode } from "react";

export const CONTRACT_ID = "ui:tool-renderer";
export const DESCRIPTION = "Per-tool UI rendering registry — pluggable presentation of tool calls in the chat surface.";

export type ToolCallStatus = "running" | "done" | "error";

export interface UiToolRenderer {
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

export interface UiToolRendererService {
  register(renderer: UiToolRenderer): () => void;
  /**
   * Human-readable one-line (or short multi-line) summary of a tool call.
   * If a renderer is registered for `name`, returns its `collapsedSummary(args)`.
   * Otherwise returns `name + "\n" + JSON.stringify(args, null, 2)` truncated to
   * roughly 1500 chars with a `… (N more chars)` suffix.
   */
  summarize(name: string, args: unknown): string;
}
