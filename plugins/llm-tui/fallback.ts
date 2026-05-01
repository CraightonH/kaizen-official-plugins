import readline from "node:readline";
import type { TuiChannelService } from "./public.d.ts";

export function createFallbackChannel(): TuiChannelService {
  let queued: string[] = [];
  let pending: ((line: string) => void) | null = null;
  let rl: readline.Interface | null = null;

  function ensureReader(): void {
    if (rl) return;
    rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      if (pending) {
        const r = pending;
        pending = null;
        r(line);
      } else {
        queued.push(line);
      }
    });
  }

  return {
    writeOutput(chunk) { process.stdout.write(chunk); },
    writeNotice(text) { process.stderr.write(`${text}\n`); },
    setBusy() { /* no-op in non-TTY mode */ },
    readInput() {
      ensureReader();
      if (queued.length > 0) {
        const next = queued.shift()!;
        return Promise.resolve(next);
      }
      return new Promise<string>((resolve) => { pending = resolve; });
    },
  };
}
