import readline from "node:readline";
import type { UiChannelService, UiPromptService } from "llm-contracts/public";
import { renderMarkdown } from "./ui/markdown.ts";

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
    // output defaults markdown:true (back-compat: was always rendered in TTY mode)
    writeOutput(chunk, opts) {
      const md = opts?.markdown !== false;
      process.stdout.write(md ? renderMarkdown(chunk) : chunk);
    },
    // notice/user default markdown:false (plain unless caller opts in)
    writeNotice(text, opts) {
      const md = opts?.markdown === true;
      process.stderr.write(`${md ? renderMarkdown(text) : text}\n`);
    },
    writeUser(text, opts) {
      const md = opts?.markdown === true;
      process.stdout.write(`> ${md ? renderMarkdown(text) : text}\n`);
    },
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

export function createFallbackPrompt(): UiPromptService {
  return {
    async requestOption(req) {
      const cancelId = req.cancelId ?? req.options.at(-1)?.id;
      if (cancelId === undefined) {
        return { id: "" };
      }
      return { id: cancelId };
    },
    async requestText() {
      return "";
    },
  };
}
