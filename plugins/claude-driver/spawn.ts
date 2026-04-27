import { spawn } from "node:child_process";

export interface ClaudeChild {
  stdout: AsyncIterable<string>;     // line-by-line
  stderr: () => string;              // accumulated stderr at any point
  kill(signal: NodeJS.Signals): void;
  wait(): Promise<number>;           // exit code
  isAlive(): boolean;
}

export type ClaudeSpawner = (args: string[]) => ClaudeChild;

export const realSpawner: ClaudeSpawner = (args) => {
  const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
  let alive = true;
  let stderrBuf = "";
  child.stderr?.on("data", (d) => { stderrBuf += String(d); });
  child.on("exit", () => { alive = false; });

  async function* lines(): AsyncIterable<string> {
    let buf = "";
    for await (const chunk of child.stdout!) {
      buf += String(chunk);
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        yield line;
      }
    }
    if (buf) yield buf;
  }

  return {
    stdout: lines(),
    stderr: () => stderrBuf,
    kill: (sig) => { try { child.kill(sig); } catch {} },
    wait: () => new Promise<number>((resolve) => {
      if (!alive) return resolve(child.exitCode ?? 0);
      child.on("exit", (code) => resolve(code ?? 0));
    }),
    isAlive: () => alive,
  };
};
