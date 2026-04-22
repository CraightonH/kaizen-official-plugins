import type { KaizenPlugin } from "kaizen/types";
import { spawn } from "node:child_process";

export type ShellResult =
  | { kind: "exec"; exitCode: number; durationMs: number }
  | { kind: "exit" }
  | { kind: "noop" }
  | { kind: "unknown-slash"; name: string };

export interface ShellExec {
  prompt(): void;
  /**
   * Handle one line of user input. Interprets `/<name>` as a slash command
   * (owned by this plugin); everything else is passed to /bin/sh.
   */
  handle(line: string): Promise<ShellResult>;
}

type SlashHandler = () => Promise<ShellResult> | ShellResult;

const plugin: KaizenPlugin = {
  name: "shell",
  apiVersion: "2.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["shell:exec"],
    consumes: ["events:vocabulary"],
  },

  async setup(ctx) {
    ctx.consumeService("events:vocabulary");
    ctx.defineService("shell:exec", {
      description: "TTY passthrough shell + slash-command dispatcher. Driver calls handle(line).",
    });

    const slashCommands: Record<string, SlashHandler> = {
      exit: () => ({ kind: "exit" }),
    };

    async function runShell(cmd: string): Promise<ShellResult> {
      const started = Date.now();
      return await new Promise((resolve) => {
        const child = spawn("/bin/sh", ["-c", cmd], { stdio: "inherit" });
        child.on("exit", (code) => {
          resolve({ kind: "exec", exitCode: code ?? -1, durationMs: Date.now() - started });
        });
        child.on("error", () => {
          resolve({ kind: "exec", exitCode: -1, durationMs: Date.now() - started });
        });
      });
    }

    const impl: ShellExec = {
      prompt() {
        process.stdout.write("$ ");
      },
      async handle(line) {
        const trimmed = line.trim();
        if (trimmed === "") return { kind: "noop" };
        if (trimmed.startsWith("/")) {
          const name = trimmed.slice(1).split(/\s+/, 1)[0] ?? "";
          const handler = slashCommands[name];
          if (!handler) return { kind: "unknown-slash", name };
          return await handler();
        }
        return await runShell(line);
      },
    };

    ctx.provideService<ShellExec>("shell:exec", impl);
    ctx.log("shell setup complete");
  },
};

export default plugin;
