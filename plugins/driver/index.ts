import type { KaizenPlugin } from "kaizen/types";

interface Vocab {
  readonly SESSION_START: string;
  readonly SESSION_END: string;
  readonly SESSION_ERROR: string;
  readonly INPUT_RECEIVED: string;
  readonly SHELL_BEFORE: string;
  readonly SHELL_AFTER: string;
}

type ShellResult =
  | { kind: "exec"; exitCode: number; durationMs: number }
  | { kind: "exit" }
  | { kind: "noop" }
  | { kind: "unknown-slash"; name: string };

interface ShellExec {
  prompt(): void;
  handle(line: string): Promise<ShellResult>;
}

const plugin: KaizenPlugin = {
  name: "driver",
  apiVersion: "2.0.0",
  driver: true,
  permissions: { tier: "trusted" },
  services: { consumes: ["events:vocabulary", "shell:exec"] },

  async setup(ctx) {
    ctx.consumeService("events:vocabulary");
    ctx.consumeService("shell:exec");
    ctx.log("driver setup complete");
  },

  async start(ctx) {
    const { readStdinLine } = (await import("kaizen/types")) as {
      readStdinLine: () => Promise<string>;
    };
    const V = ctx.useService<Vocab>("events:vocabulary");
    const shell = ctx.useService<ShellExec>("shell:exec");

    await ctx.emit(V.SESSION_START);
    try {
      while (true) {
        shell.prompt();
        const line = await readStdinLine();
        if (line === "") break; // EOF
        await ctx.emit(V.INPUT_RECEIVED, { line });
        await ctx.emit(V.SHELL_BEFORE, { line });
        const result = await shell.handle(line);
        await ctx.emit(V.SHELL_AFTER, result);
        if (result.kind === "exit") break;
      }
    } catch (err) {
      await ctx.emit(V.SESSION_ERROR, { message: (err as Error).message });
      throw err;
    } finally {
      await ctx.emit(V.SESSION_END);
    }
  },
};

export default plugin;
