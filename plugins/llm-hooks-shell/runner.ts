import type { HookEntry } from "./config.ts";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunnerDeps {
  exec: (
    bin: string,
    args: string[],
    opts: { cwd?: string; env: Record<string, string>; timeoutMs: number },
  ) => Promise<ExecResult>;
  log: (level: "info" | "warn", msg: string) => void;
}

export interface HookOutcome {
  ok: boolean;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function runHook(
  entry: HookEntry,
  baseEnv: Record<string, string>,
  deps: RunnerDeps,
): Promise<HookOutcome> {
  const env = { ...baseEnv, ...(entry.env ?? {}) };
  const timeoutMs = entry.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const cwd = entry.cwd;

  let res: ExecResult;
  try {
    res = await deps.exec("sh", ["-c", entry.command], { cwd, env, timeoutMs });
  } catch (e: any) {
    const isTimeout = e?.code === "ETIMEDOUT" || /timeout/i.test(String(e?.message ?? ""));
    const reason = isTimeout ? `timeout after ${timeoutMs}ms` : (e?.message ?? String(e));
    deps.log("warn", `[hook event=${entry.event}] ${reason}`);
    return { ok: false, stderr: reason };
  }

  if (res.exitCode === 0) {
    const lines = res.stdout.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      deps.log("info", `[hook event=${entry.event}] ${line}`);
    }
    return { ok: true, stderr: "" };
  }

  const stderrText = res.stderr || `exit ${res.exitCode}`;
  deps.log("warn", `[hook event=${entry.event}] exit=${res.exitCode} ${stderrText}`);
  return { ok: false, stderr: stderrText };
}
