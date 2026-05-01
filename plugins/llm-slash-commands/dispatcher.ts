import { parse } from "./parser.ts";
import type { SlashRegistryService, SlashCommandContext } from "./registry.ts";
import { ReentrantSlashEmitError } from "./errors.ts";

export interface DispatcherBus {
  emit: (event: string, payload: unknown) => Promise<void>;
  signal: AbortSignal;
}

export interface DispatcherDeps {
  registry: SlashRegistryService;
  bus: DispatcherBus;
}

export function makeOnInputSubmit(deps: DispatcherDeps): (payload: { text: string }) => Promise<void> {
  let inSlashDispatch = false;

  return async function onInputSubmit(payload: { text: string }) {
    if (inSlashDispatch) return;
    const parsed = parse(payload.text);
    if (!parsed) return;

    inSlashDispatch = true;
    try {
      const wrappedEmit = async (event: string, p: unknown) => {
        if (event === "input:submit") throw new ReentrantSlashEmitError(event);
        await deps.bus.emit(event, p);
      };
      const print = async (text: string) => {
        await deps.bus.emit("conversation:system-message", {
          message: { role: "system", content: text },
        });
      };
      const ctx: SlashCommandContext = {
        args: parsed.args,
        raw: payload.text,
        signal: deps.bus.signal,
        emit: wrappedEmit,
        print,
      };

      const entry = deps.registry.get(parsed.name);
      if (!entry) {
        await deps.bus.emit("conversation:system-message", {
          message: { role: "system", content: `Unknown command: /${parsed.name}. Type /help for a list.` },
        });
      } else {
        try {
          await entry.handler(ctx);
        } catch (e) {
          await deps.bus.emit("session:error", {
            message: (e as Error).message ?? String(e),
            cause: e,
          });
        }
      }
      await deps.bus.emit("input:handled", { by: "llm-slash-commands" });
    } finally {
      inSlashDispatch = false;
    }
  };
}
