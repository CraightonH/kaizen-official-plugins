import * as readline from "node:readline";
import type { UiChannel } from "./public.d.ts";

export function createFallbackChannel(): UiChannel {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  let pending: ((s: string) => void) | null = null;
  rl.on("line", (line) => { const r = pending; pending = null; r?.(line); });
  rl.on("close", () => { const r = pending; pending = null; r?.(""); });

  return {
    readInput() {
      return new Promise((resolve) => { pending = resolve; });
    },
    writeOutput(chunk: string) { process.stdout.write(chunk); },
    writeNotice(line: string) { process.stdout.write(`\x1b[2m${line}\x1b[0m\n`); },
    setBusy() { /* no-op in non-TTY mode */ },
  };
}
