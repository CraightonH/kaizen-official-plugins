// Ambient globals injected into a workflow script by the llm-workflow sandbox.
// Workflow authors can reference this file via:
//   /// <reference path="../../node_modules/llm-workflow/ambient.d.ts" />
// or import as a type-only module.

import type { WorkflowPhase } from "llm-contracts/public";

declare global {
  /** Run a subagent. Returns the final assistant text. */
  function agent(prompt: string, opts?: {
    label?: string;
    phase?: string;
    schema?: object;          // reserved (v1.1)
    model?: string;
    isolation?: "worktree";   // reserved (v1.1)
    agentType?: string;
  }): Promise<string | null>;

  /** Run thunks concurrently — barrier. Failures resolve to `null` in the result array. */
  function parallel<T = unknown>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;

  /** Pipeline items across stages with no barrier between stages. */
  function pipeline<T = unknown>(items: T[], ...stages: Array<(prev: unknown, item: T, index: number) => Promise<unknown>>): Promise<unknown[]>;

  /** Emit a phase boundary in the progress stream. */
  function phase(title: string): void;

  /** Emit a free-form narrator line. */
  function log(message: string): void;

  /** Run a child workflow. Shares this run's semaphore, budget, abort signal, and lifetime counter. */
  function workflow(nameOrRef: string | { scriptPath: string }, args?: unknown): Promise<unknown>;

  /** Args passed via RunOptions.args at invocation time. */
  const args: any;

  /** Budget accounting. */
  const budget: {
    total: number | null;
    spent(): Promise<number>;
    remaining(): Promise<number>;
  };
}

export {};
