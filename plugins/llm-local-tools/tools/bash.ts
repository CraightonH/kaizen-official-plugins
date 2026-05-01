// plugins/llm-local-tools/tools/bash.ts
import { spawn } from "node:child_process";
import type { ToolSchema } from "llm-events/public";
import { resolvePath, truncateMiddle, BASH_OUTPUT_CAP } from "../util.ts";

export const schema: ToolSchema = {
  name: "bash",
  description: "Execute a shell command. Captures combined stdout/stderr. Default timeout 120s. Use sparingly — prefer purpose-built tools when one exists.",
  parameters: {
    type: "object",
    properties: {
      command:           { type: "string" },
      cwd:               { type: "string", description: "Working directory. Defaults to process cwd." },
      timeout:           { type: "integer", minimum: 1000, maximum: 600000, description: "Milliseconds. Default 120000. Hard max 600000 (10 min)." },
      run_in_background: { type: "boolean", default: false, description: "Reserved. Currently rejected if true." },
    },
    required: ["command"],
  },
  tags: ["local", "shell"],
};

interface BashArgs {
  command: string;
  cwd?: string;
  timeout?: number;
  run_in_background?: boolean;
}

interface BashResult {
  exit_code: number;
  output: string;
  duration_ms: number;
  truncated: boolean;
  killed_by_timeout: boolean;
}

function killGroup(pid: number, signal: string): void {
  try {
    // Negative pid kills the entire process group
    process.kill(-pid, signal as NodeJS.Signals);
  } catch {
    try { process.kill(pid, signal as NodeJS.Signals); } catch { /* ignore */ }
  }
}

export async function handler(args: BashArgs, ctx: any): Promise<BashResult> {
  if (args.run_in_background === true) throw new Error("bash: run_in_background is not supported in v0");
  const cwd = resolvePath(args.cwd ?? ".");
  const timeout = Math.min(600000, Math.max(1000, args.timeout ?? 120000));
  const start = Date.now();

  return new Promise<BashResult>((resolve) => {
    // detached: true creates a new process group so we can kill the whole group
    const child = spawn(args.command, { cwd, shell: true, detached: true });
    const chunks: Buffer[] = [];
    let killedByTimeout = false;
    let killedBySignal = false;
    let totalBytes = 0;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const onData = (b: Buffer) => {
      chunks.push(b);
      totalBytes += b.length;
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const doKill = (reason: "timeout" | "signal") => {
      if (reason === "timeout") killedByTimeout = true;
      else killedBySignal = true;
      const pid = child.pid;
      if (pid != null) {
        killGroup(pid, "SIGTERM");
        killTimer = setTimeout(() => {
          try { killGroup(pid, "SIGKILL"); } catch { /* ignore */ }
        }, 2000);
      }
    };

    const timer = setTimeout(() => doKill("timeout"), timeout);

    const onAbort = () => doKill("signal");
    if (ctx?.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer != null) clearTimeout(killTimer);
      if (ctx?.signal) ctx.signal.removeEventListener?.("abort", onAbort as any);
      const duration = Date.now() - start;
      let raw = Buffer.concat(chunks).toString("utf8");
      if (killedByTimeout) raw += `\n... [killed: timeout after ${timeout}ms]`;
      else if (killedBySignal) raw += `\n... [killed: cancelled by signal]`;
      const wasTruncated = totalBytes > BASH_OUTPUT_CAP;
      const out = wasTruncated
        ? truncateMiddle(raw, BASH_OUTPUT_CAP, `... [truncated: ${totalBytes - BASH_OUTPUT_CAP} bytes elided from middle] ...`)
        : raw;
      const exitCode = code ?? (signal ? 128 + 15 : 1);
      resolve({
        exit_code: exitCode,
        output: out,
        duration_ms: duration,
        truncated: wasTruncated,
        killed_by_timeout: killedByTimeout,
      });
    });
  });
}
