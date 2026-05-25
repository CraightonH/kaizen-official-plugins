import type { KaizenPlugin } from "kaizen/types";
import { CANCEL_TOOL } from "llm-events";
import type {
  ToolBeforeExecutePayload,
  UiPromptService,
  UiToolRendererService,
  UiChannelService,
  ConfigStoreService,
} from "llm-contracts/public";
import type { ToolApprovalConfig } from "./public.d.ts";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";
import { makeSubscriber, type Subscriber } from "./subscriber.ts";
import { registerSlashCommands, type SlashRegistryLike, type ApprovalState } from "./slash.ts";
import { persistProjectAllow } from "./persist.ts";

const PLUGIN_NAME = "llm-tool-approval";

const plugin: KaizenPlugin = {
  name: PLUGIN_NAME,
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    consumes: ["ui:prompt", "ui:tool-renderer", "ui:channel", "ui:status", "slash:registry", "config:store"],
  },

  async setup(ctx) {
    const log = (m: string) => ctx.log?.(m);

    // Load config (topo-hint optional). If config:store is unavailable or
    // register() throws, fall back to the shipped DEFAULT_CONFIG so the gate
    // still gates — every persistence attempt becomes a best-effort no-op
    // (consistent with the "write failure ≠ approval failure" invariant).
    let config: ToolApprovalConfig = { ...DEFAULT_CONFIG };
    let cfgSvc: ConfigStoreService | null = null;
    try {
      cfgSvc = ctx.useService<ConfigStoreService>("config:store") ?? null;
    } catch {
      cfgSvc = null;
    }
    if (cfgSvc) {
      try {
        cfgSvc.register<ToolApprovalConfig>({
          plugin: PLUGIN_NAME,
          defaults: { ...DEFAULT_CONFIG },
          schema: CONFIG_SCHEMA,
        });
        config = cfgSvc.get<ToolApprovalConfig>(PLUGIN_NAME);
      } catch (e) {
        log(`${PLUGIN_NAME}: config:store register failed (${(e as Error).message}); using defaults`);
      }
    } else {
      log(`${PLUGIN_NAME}: config:store unavailable; using DEFAULT_CONFIG`);
    }

    const state: ApprovalState = { paused: false };

    const rules = (): ToolApprovalConfig => {
      if (!cfgSvc) {
        return { allow: [...config.allow], deny: [...config.deny] };
      }
      const v = cfgSvc.get<ToolApprovalConfig>(PLUGIN_NAME);
      return {
        allow: Array.isArray(v?.allow) ? v.allow : [],
        deny: Array.isArray(v?.deny) ? v.deny : [],
      };
    };

    const persistAllow = async (entry: string): Promise<void> => {
      if (!cfgSvc) {
        log(`${PLUGIN_NAME}: config:store unavailable; cannot persist "${entry}" — approval is one-time`);
        return;
      }
      await persistProjectAllow(PLUGIN_NAME, entry, { cfgSvc, log: ctx.log });
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
        ctx.log(`${PLUGIN_NAME}: ui:prompt service unavailable — every call will auto-deny. (${(err as Error).message})`);
      }

      let summarize: (name: string, args: unknown) => string = (name, args) =>
        `${name}\n${safeJsonStringify(args)}`;
      try {
        const renderer = ctx.useService<UiToolRendererService>("ui:tool-renderer");
        summarize = (name, args) => renderer.summarize(name, args);
      } catch (err) {
        ctx.log(`${PLUGIN_NAME}: ui:tool-renderer missing — falling back to JSON stringify. (${(err as Error).message})`);
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
        if (cfgSvc) {
          const offs = registerSlashCommands(slash, { state, setStatus, cfgSvc });
          teardowns.push(...offs);
        } else {
          log(`${PLUGIN_NAME}: config:store unavailable; slash commands not registered`);
        }
      } catch (err) {
        ctx.log(`${PLUGIN_NAME}: slash:registry unavailable — slash commands not registered. (${(err as Error).message})`);
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
