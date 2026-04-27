import * as readline from "node:readline";

export interface InputReader {
  readLine(): Promise<string>;     // resolves on Enter; "" on EOF.
  close(): void;
}

export function createInputReader(opts?: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  onSigInt?: () => void;
}): InputReader {
  const rl = readline.createInterface({
    input: opts?.input ?? process.stdin,
    output: opts?.output ?? process.stdout,
    terminal: true,
  });
  let pendingResolve: ((s: string) => void) | null = null;

  rl.on("line", (line) => {
    const r = pendingResolve;
    pendingResolve = null;
    r?.(line);
  });
  rl.on("close", () => {
    const r = pendingResolve;
    pendingResolve = null;
    r?.("");
  });
  if (opts?.onSigInt) {
    rl.on("SIGINT", opts.onSigInt);
  } else {
    rl.on("SIGINT", () => rl.close());
  }

  return {
    readLine() {
      return new Promise((resolve) => { pendingResolve = resolve; });
    },
    close() { rl.close(); },
  };
}
