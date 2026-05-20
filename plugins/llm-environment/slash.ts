type SlashContext = { print(message: string): void };
type SlashInvocation = { args: string; argv: string[] };
type SlashHandler = (invocation: SlashInvocation, ctx: SlashContext) => Promise<void> | void;

export interface EnvSlashOptions {
  refresh: () => Promise<void>;
}

export interface EnvSlashEntry {
  name: string;
  description: string;
  handler: SlashHandler;
}

export function makeEnvSlashHandlers(opts: EnvSlashOptions): { refresh: EnvSlashEntry } {
  return {
    refresh: {
      name: "env:refresh",
      description: "Refresh and re-capture the working-directory / platform / git snapshot used in the system prompt.",
      handler: async (_inv, ctx) => {
        await opts.refresh();
        ctx.print("environment refreshed");
      },
    },
  };
}
