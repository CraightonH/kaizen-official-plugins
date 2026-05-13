import readline from "node:readline";
import type { UiChannelService } from "llm-contracts/public";

export function createFallbackChannel(): UiChannelService {
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
    writeUser(text) { process.stdout.write(`> ${text}\n`); },
    setBusy() { /* no-op in non-TTY mode */ },
    setBusyTiming() { /* no-op in non-TTY mode */ },
    updateBusyTokens() { /* no-op in non-TTY mode */ },
    incrementBusyTokens() { /* no-op in non-TTY mode */ },
    appendReasoning() { /* no-op: thinking deltas are dropped in non-TTY mode */ },
    finalizeReasoning() { /* no-op */ },
    clearLiveThinking() { /* no-op */ },
    setInputDraft() { /* no-op: no input buffer in non-TTY mode */ },
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
