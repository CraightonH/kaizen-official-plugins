import type { KaizenPlugin } from "kaizen/types";
import { CANCEL_TOOL } from "llm-events";
import type {
  ToolBeforeExecutePayload,
  UiPromptService,
  UiToolRendererService,
  UiChannelService,
  ConfigStoreService,
} from "llm-contracts/public";
import defaultsRaw from "./defaults.json" with { type: "json" };
import { makeSubscriber, type Subscriber } from "./subscriber.ts";
import { registerSlashCommands, type SlashRegistryLike, type ApprovalState } from "./slash.ts";
import { persistProjectAllow } from "./persist.ts";

export interface ToolApprovalConfig {
  allow: string[];
  deny: string[];
}

const plugin: KaizenPlugin = {
  name: "llm-tool-approval",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    consumes: ["ui:prompt", "ui:tool-renderer", "ui:channel", "ui:status", "slash:registry", "config:store"],
  },

  async setup(ctx) {
    ctx.consumeService("ui:prompt");
    ctx.consumeService("ui:tool-renderer");
    ctx.consumeService("ui:channel");
    ctx.consumeService("slash:registry");
    ctx.consumeService("config:store");

    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    cfgSvc.register<ToolApprovalConfig>({
      plugin: "llm-tool-approval",
      defaults: {
        allow: Array.isArray((defaultsRaw as any).allow) ? ((defaultsRaw as any).allow as string[]) : [],
        deny: Array.isArray((defaultsRaw as any).deny) ? ((defaultsRaw as any).deny as string[]) : [],
      },
      schema: {
        allow: { type: "array", items: { type: "string" } },
        deny: { type: "array", items: { type: "string" } },
      },
    });

    const state: ApprovalState = { paused: false };

    const rules = (): ToolApprovalConfig => {
      const v = cfgSvc.get<ToolApprovalConfig>("llm-tool-approval");
      return {
        allow: Array.isArray(v?.allow) ? v.allow : [],
        deny: Array.isArray(v?.deny) ? v.deny : [],
      };
    };

    const persistAllow = async (entry: string): Promise<void> => {
      await persistProjectAllow("llm-tool-approval", entry, { cfgSvc, log: ctx.log });
    };

    let teardowns: Array<() => void> = [];

    // Subscriber is registered now (setup is the only window where ctx.on is
    // allowed). Until harness:start resolves services, it no-ops; the brief
    // window before harness:start should not see any tool calls anyway.
    let handler: Subscriber = async (_p) => { /* not ready yet */ };
    ctx.on("tool:before-execute", ((payload: ToolBeforeExecutePayload) => handler(payload)) as (payload?: unknown) => Promise<void>);

    ctx.on("harness:start", async () => {
      let uiPrompt: UiPromptService | null = null;
      try {
        uiPrompt = ctx.useService<UiPromptService>("ui:prompt");
      } catch (err) {
        ctx.log(`llm-tool-approval: ui:prompt service unavailable — every call will auto-deny. (${(err as Error).message})`);
      }

      let summarize: (name: string, args: unknown) => string = (name, args) =>
        `${name}\n${safeJsonStringify(args)}`;
      try {
        const renderer = ctx.useService<UiToolRendererService>("ui:tool-renderer");
        summarize = (name, args) => renderer.summarize(name, args);
      } catch (err) {
        ctx.log(`llm-tool-approval: ui:tool-renderer missing — falling back to JSON stringify. (${(err as Error).message})`);
      }

      let writeNotice: (text: string) => void = (text) => ctx.log(text);
      try {
        const channel = ctx.useService<UiChannelService>("ui:channel");
        writeNotice = (text) => channel.writeNotice(text);
      } catch { /* ignore */ }

      const setStatus = (value: "request" | "paused") => {
        void ctx.emit("status:item-update", { key: "approval", value });
      };
      setStatus("request");

      try {
        const slash = ctx.useService<SlashRegistryLike>("slash:registry");
        const offs = registerSlashCommands(slash, { state, setStatus, cfgSvc });
        teardowns.push(...offs);
      } catch (err) {
        ctx.log(`llm-tool-approval: slash:registry unavailable — slash commands not registered. (${(err as Error).message})`);
      }

      const subscriber = makeSubscriber({
        isPaused: () => state.paused,
        rules,
        summarize,
        prompt: uiPrompt ?? {
          requestOption: async (_req) => ({ id: "__missing__" }),
          requestText: async () => "",
        },
        persistAllow,
        writeNotice,
        log: ctx.log,
      });

      handler = uiPrompt
        ? subscriber
        : async (p: ToolBeforeExecutePayload) => {
            if (p.args === CANCEL_TOOL) return;
            p.args = CANCEL_TOOL;
            p.cancelReason = "approval gate misconfigured: no ui:prompt service";
          };
    });

    ctx.on("harness:end", async () => {
      for (const off of teardowns) { try { off(); } catch { /* ignore */ } }
      teardowns = [];
      handler = async (_p) => { /* not ready */ };
      void ctx.emit("status:item-clear", { key: "approval" });
    });
  },
};

function safeJsonStringify(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}


export default plugin;
