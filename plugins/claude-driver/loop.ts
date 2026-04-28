import { parseStreamJsonLine } from "./parser.ts";
import type { ClaudeSpawner } from "./spawn.ts";

export function buildArgs(prompt: string, hasSession: boolean): string[] {
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (hasSession) args.push("--continue");
  return args;
}

export interface RunTurnOpts {
  prompt: string;
  hasSession: boolean;
  spawner: ClaudeSpawner;
  writeOutput: (chunk: string) => void;
  emit: (event: string, payload?: any) => Promise<void>;
  log: (msg: string) => void;
  graceMs?: number;            // grace before SIGTERM after result; default 2000
  cancelSignal?: AbortSignal;  // emits SIGINT to child if aborted
}

export interface TurnResult {
  sessionId: string | null;
  exitCode: number;
  cancelled: boolean;
}

export async function runTurn(opts: RunTurnOpts): Promise<TurnResult> {
  const { prompt, hasSession, spawner, writeOutput, emit, log } = opts;
  const grace = opts.graceMs ?? 2000;
  const child = spawner(buildArgs(prompt, hasSession));

  let sessionId: string | null = null;
  let cancelled = false;
  let wroteAnyText = false;
  const onCancel = () => { cancelled = true; child.kill("SIGINT"); };
  opts.cancelSignal?.addEventListener("abort", onCancel);

  try {
    let sawResult = false;

    for await (const line of child.stdout) {
      const ev = parseStreamJsonLine(line);
      if (!ev) continue;
      switch (ev.kind) {
        case "init":
          await emit("status:item-update", { id: "llm.model", content: ev.model, priority: 10 });
          if (ev.sessionId) sessionId = ev.sessionId;
          break;
        case "text-delta":
          writeOutput(ev.text);
          wroteAnyText = true;
          break;
        case "result": {
          sawResult = true;
          if (ev.sessionId) sessionId = ev.sessionId;
          const inK = formatTokens(ev.tokensIn);
          const outK = formatTokens(ev.tokensOut);
          await emit("status:item-update", {
            id: "llm.context",
            content: `${inK} in · ${outK} out`,
            priority: 20,
          });
          await emit("turn:after", {
            tokensIn: ev.tokensIn,
            tokensOut: ev.tokensOut,
            cacheReadTokens: ev.cacheReadTokens,
            cacheCreationTokens: ev.cacheCreationTokens,
            durationMs: ev.durationMs,
          });
          break;
        }
        case "retry":
          log(`api retry attempt ${ev.attempt}/${ev.maxRetries} after ${ev.retryDelayMs}ms (${ev.error})`);
          break;
        case "malformed":
          log(`dropped malformed stream-json line: ${ev.raw.slice(0, 80)}`);
          break;
        case "unknown":
          break;
      }
    }

    // Make sure the assistant's streamed text is followed by a newline before
    // the UI repaints the prompt. claude does not emit a trailing newline.
    if (wroteAnyText) writeOutput("\n");

    if (sawResult && child.isAlive()) {
      await sleep(grace);
      if (child.isAlive()) {
        child.kill("SIGTERM");
        await sleep(grace);
        if (child.isAlive()) child.kill("SIGKILL");
      }
    }

    const exitCode = await child.wait();
    return { sessionId, exitCode, cancelled };
  } finally {
    opts.cancelSignal?.removeEventListener("abort", onCancel);
  }
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
