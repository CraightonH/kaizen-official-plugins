export type ShellResult =
  | { kind: "exec"; exitCode: number; durationMs: number }
  | { kind: "exit" }
  | { kind: "noop" }
  | { kind: "unknown-slash"; name: string };

export interface ShellExec {
  prompt(): void;
  handle(line: string): Promise<ShellResult>;
}
