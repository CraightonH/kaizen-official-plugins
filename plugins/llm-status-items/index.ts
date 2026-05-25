import type { KaizenPlugin } from "kaizen/types";
import type { ConfigStoreService, LLMCompleteService, ModelInfo, Vocab } from "llm-contracts/public";
import { applyEvent, initialState, type StatusState } from "./state.ts";
import { formatDollars, tokensToCents, type RateTable } from "./cost.ts";
import { formatContextItem } from "./context.ts";
import { buildSnapshot } from "./snapshot.ts";
import { registerStatusSlash, type SlashRegistryLike } from "./slash.ts";
import { registerStatusTool, type ToolsRegistryLike } from "./tool.ts";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";
import type { LlmStatusItemsConfig } from "./public.d.ts";

function subscribedEvents(vocab: Vocab): string[] {
  return [
    vocab.HARNESS_START,
    vocab.LLM_BEFORE_CALL,
    vocab.LLM_DONE,
    vocab.TURN_START,
    vocab.TURN_END,
    vocab.TOOL_BEFORE_EXECUTE,
    vocab.TOOL_RESULT,
    vocab.TOOL_ERROR,
    vocab.CONVERSATION_CLEARED,
    vocab.SESSION_ACTIVE_CHANGED,
    vocab.SESSION_RENAMED,
  ];
}

const plugin: KaizenPlugin = {
  name: "llm-status-items",
  apiVersion: "3.0.0",
  permissions: {
    tier: "scoped",
    events: {
      subscribe: [
        "harness:start",
        "llm:before-call",
        "llm:done",
        "turn:start",
        "turn:end",
        "tool:before-execute",
        "tool:result",
        "tool:error",
        "conversation:cleared",
        "session:active-changed",
        "session:renamed",
      ],
      emit: ["status:item-update", "status:item-clear"],
    },
  },
  services: { consumes: ["events:vocabulary", "llm:complete", "config:store"] },

  async setup(ctx) {
    const log = (m: string) => ctx.log?.(m);

    // Load config (topo-hint optional).
    let config: LlmStatusItemsConfig = { ...DEFAULT_CONFIG };
    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (cfgSvc) {
      try {
        cfgSvc.register<LlmStatusItemsConfig>({
          plugin: "llm-status-items",
          defaults: { ...DEFAULT_CONFIG },
          schema: CONFIG_SCHEMA,
        });
        config = cfgSvc.get<LlmStatusItemsConfig>("llm-status-items");
      } catch (e) {
        log(`llm-status-items: config:store register failed (${(e as Error).message}); using defaults`);
      }
    } else {
      log("llm-status-items: config:store unavailable; using DEFAULT_CONFIG");
    }

    ctx.consumeService("events:vocabulary");
    const vocab = ctx.useService<Vocab>("events:vocabulary");
    // Consumed lazily — listModels() only runs the first time we see a
    // model id at runtime, by which point the provider has registered.
    ctx.consumeService("llm:complete");

    const rates: RateTable = config.costRates;
    const hasAnyRate = Object.keys(rates).length > 0;
    const barOptions = {
      width: config.contextBarWidth,
      fillGlyph: config.contextBarFillGlyph,
      emptyGlyph: config.contextBarEmptyGlyph,
    };

    let state: StatusState = initialState();
    let costCents = 0;
    let costActive = false; // becomes true after first successful cost emission; controls whether to clear on conversation:cleared
    // Flips on the first harness:start. Lets emitDiff render zero token
    // counters and the empty context bar before any turn has run, so the
    // status line isn't half-empty at idle.
    let initialized = false;

    let lastEmitted = {
      model: null as string | null,
      io: null as string | null,
      tokensPerSec: null as string | null,
      cost: null as string | null,
      ctx: null as string | null,
      session: null as string | null,
    };

    // Per-model context-window cache. listModels() is called lazily the first
    // time we see a new model id and the result is reused thereafter — no
    // request-per-turn overhead, and providers that don't expose the field
    // are simply marked as "unknown" so we don't keep retrying.
    const contextCache = new Map<string, number | null>();
    let modelsListed = false;
    // Fallback ceiling derived from "the single currently-loaded model" —
    // used when state.model is unset (driver didn't pass `model`, provider
    // resolved its own default) or when the named model isn't in the list.
    // For LM Studio, exactly one entry carries `loadedContextLength`, which
    // is precisely what we want regardless of how we got here.
    let ambientLoadedCeiling: number | null = null;
    // Id of the runtime-loaded model. Surfaces a `model` status item even
    // when the driver leaves request.model unset (the provider resolves its
    // own default — common with LM Studio / Ollama / vLLM).
    let ambientLoadedModelId: string | null = null;

    async function listOnce(): Promise<void> {
      if (modelsListed) return;
      let llm: LLMCompleteService | null = null;
      let useErr: string | null = null;
      try { llm = ctx.useService<LLMCompleteService>("llm:complete") ?? null; } catch (e) { llm = null; useErr = (e as Error).message; }
      modelsListed = true;
      // TEMP DIAGNOSTIC
      ctx.log?.(`llm-status-items[dbg] listOnce: useService=${llm ? "ok" : "null"} useErr=${useErr ?? "-"}`);
      if (!llm) return;
      try {
        const models: ModelInfo[] = await llm.listModels();
        // TEMP DIAGNOSTIC
        ctx.log?.(`llm-status-items[dbg] listModels returned ${models.length} model(s): ${models.map((m) => `${m.id}(loaded=${m.loadedContextLength ?? "-"} max=${m.maxContextLength ?? "-"} ctx=${m.contextLength ?? "-"})`).join(", ")}`);
        for (const m of models) {
          const ceiling = m.loadedContextLength ?? m.maxContextLength ?? m.contextLength ?? null;
          contextCache.set(m.id, ceiling);
          if (m.loadedContextLength != null && ambientLoadedCeiling === null) {
            ambientLoadedCeiling = m.loadedContextLength;
            ambientLoadedModelId = m.id;
          }
        }
      } catch (e) {
        // TEMP DIAGNOSTIC
        ctx.log?.(`llm-status-items[dbg] listModels threw: ${(e as Error).message}`);
        // listModels not supported or transient failure — ctx item silently
        // hidden, all other status items continue to work.
      }
    }

    async function resolveCeiling(model: string | null): Promise<number | null> {
      await listOnce();
      if (model && contextCache.has(model)) {
        const v = contextCache.get(model) ?? null;
        if (v !== null) return v;
      }
      // Named lookup missed (model unset, or list didn't include it). Fall
      // back to the runtime-loaded model — which on local backends is the
      // one actually serving this call.
      return ambientLoadedCeiling;
    }

    async function emitDiff() {
      // session — full uuid so it can be copy/pasted to resume; appended
      // with the alias in parens when set. Cleared when no session is active.
      const sessionDisplay = state.sessionId
        ? (state.sessionAlias ? `${state.sessionId} (${state.sessionAlias})` : state.sessionId)
        : null;
      if (sessionDisplay !== lastEmitted.session) {
        if (sessionDisplay === null) {
          await ctx.emit(vocab.STATUS_ITEM_CLEAR, { key: "session" });
        } else {
          await ctx.emit(vocab.STATUS_ITEM_UPDATE, { key: "session", value: sessionDisplay });
        }
        lastEmitted.session = sessionDisplay;
      }
      // model
      if (state.model && state.model !== lastEmitted.model) {
        await ctx.emit(vocab.STATUS_ITEM_UPDATE, { key: "_model", value: state.model });
        lastEmitted.model = state.model;
      }
      // tokens — single labelless item rendering `<in> ↑ <out> ↓`. The arrows
      // self-label the values (↑ sent, ↓ received), saving the `in `/`out `
      // prefixes that previously ate two label widths on the bar.
      const ioV = `${state.promptTokens} ↑ ${state.completionTokens} ↓`;
      // Once we've initialized (after harness:start), surface zeros too —
      // an empty status line is worse than visible defaults.
      const haveTokens = initialized || state.promptTokens > 0 || state.completionTokens > 0;
      if (state.cleared) {
        for (const key of ["_io", "tok/s"] as const) {
          const slot = key === "_io" ? "io" : "tokensPerSec";
          if (lastEmitted[slot] !== null) {
            await ctx.emit(vocab.STATUS_ITEM_CLEAR, { key });
          }
        }
        lastEmitted.io = lastEmitted.tokensPerSec = null;
      } else if (haveTokens) {
        if (ioV !== lastEmitted.io) {
          await ctx.emit(vocab.STATUS_ITEM_UPDATE, { key: "_io", value: ioV });
          lastEmitted.io = ioV;
        }
      }
      // tok/s — show 0 before the first measurement so the slot is visible.
      const tpsValue = state.tokensPerSec === null
        ? (initialized ? "0" : null)
        : state.tokensPerSec >= config.tokensPerSecIntegerThreshold
          ? state.tokensPerSec.toFixed(0)
          : state.tokensPerSec.toFixed(1);
      if (tpsValue !== null && tpsValue !== lastEmitted.tokensPerSec) {
        await ctx.emit(vocab.STATUS_ITEM_UPDATE, { key: "tok/s", value: tpsValue });
        lastEmitted.tokensPerSec = tpsValue;
      }
      // context window — only renderable once we know the ceiling AND have
      // a prompt-token sample. State.cleared resets both, so the cleared
      // branch above already covers the clear case.
      if (state.cleared && lastEmitted.ctx !== null) {
        await ctx.emit(vocab.STATUS_ITEM_CLEAR, { key: "_ctx" });
        lastEmitted.ctx = null;
      } else if (state.contextLength) {
        // Render with zero used before any call has been made. Keeps the bar
        // visible from harness:start instead of waiting for first llm:done.
        const value = formatContextItem(state.lastPromptTokens, state.contextLength, barOptions);
        if (value !== lastEmitted.ctx) {
          await ctx.emit(vocab.STATUS_ITEM_UPDATE, { key: "_ctx", value });
          lastEmitted.ctx = value;
        }
      }
    }

    async function emitCost(eventName: string, payload: any) {
      if (!hasAnyRate) return; // fully local — never emit cost-estimate
      if (eventName === vocab.CONVERSATION_CLEARED) {
        costCents = 0;
        if (costActive) {
          await ctx.emit(vocab.STATUS_ITEM_CLEAR, { key: "cost-estimate" });
          lastEmitted.cost = null;
          costActive = false;
        }
        return;
      }
      if (eventName !== vocab.LLM_DONE) return;
      const usage = payload?.response?.usage;
      if (!usage || !state.model) return;
      const inc = tokensToCents(rates, state.model, usage);
      if (inc === null) {
        // Model not in table — clear any prior cost-estimate.
        if (costActive) {
          await ctx.emit(vocab.STATUS_ITEM_CLEAR, { key: "cost-estimate" });
          lastEmitted.cost = null;
          costActive = false;
        }
        return;
      }
      costCents += inc;
      const display = formatDollars(costCents, config.costDecimalPlaces);
      if (display !== lastEmitted.cost) {
        await ctx.emit(vocab.STATUS_ITEM_UPDATE, { key: "cost-estimate", value: display });
        lastEmitted.cost = display;
        costActive = true;
      }
    }

    for (const name of subscribedEvents(vocab)) {
      ctx.on(name, async (payload: any) => {
        state = applyEvent(state, name, payload);
        // TEMP DIAGNOSTIC — remove after model/ctx regression is found.
        ctx.log?.(`llm-status-items[dbg] evt=${name} state.model=${state.model ?? "null"} state.contextLength=${state.contextLength ?? "null"} ambientId=${ambientLoadedModelId ?? "null"} ambientCeil=${ambientLoadedCeiling ?? "null"} modelsListed=${modelsListed}`);
        // harness:start: probe the provider once so the bar can render
        // model + ctx before any turn runs, and flip `initialized` so
        // zero-valued counters appear instead of being suppressed.
        // llm:before-call / llm:done: same probe in case harness:start
        // landed before the provider service was available.
        if (state.contextLength === null && (name === "harness:start" || name === "llm:before-call" || name === "llm:done")) {
          const ceiling = await resolveCeiling(state.model);
          if (ceiling !== null) state = { ...state, contextLength: ceiling };
          if (!state.model && ambientLoadedModelId) {
            state = { ...state, model: ambientLoadedModelId };
          }
        }
        if (name === "harness:start") initialized = true;
        await emitDiff();
        await emitCost(name, payload);
      });
    }

    // Snapshot getter for /status:show + status:show tool. Reads `state`,
    // `costCents`, and `costActive` from this closure so every call returns
    // current values without any caching.
    const getSnapshot = () => buildSnapshot(state, costActive ? costCents : null);

    // Soft registration on harness:start — slash and tools registries are
    // optional peers. Both adapters are thin wrappers around the same
    // getSnapshot closure; either can be absent without affecting the other.
    let adaptersRegistered = false;
    let adapterUnregisters: Array<() => void> = [];
    ctx.on(vocab.HARNESS_START, async () => {
      if (adaptersRegistered) return;
      adaptersRegistered = true;
      if (config.slashCommandEnabled) {
        try {
          const slash = ctx.useService<SlashRegistryLike>("slash:registry");
          if (slash) adapterUnregisters.push(...registerStatusSlash(slash, getSnapshot));
        } catch { /* slash:registry absent — skip */ }
      }
      if (config.toolEnabled) {
        try {
          const toolsReg = ctx.useService<ToolsRegistryLike>("tools:registry");
          if (toolsReg) adapterUnregisters.push(...registerStatusTool(toolsReg, getSnapshot));
        } catch { /* tools:registry absent — skip */ }
      }
    });

    (plugin as any)._stop = () => {
      for (const unregister of adapterUnregisters.splice(0)) {
        try { unregister(); } catch { /* ignore */ }
      }
      adaptersRegistered = false;
    };
  },

  async stop() {
    const fn = (plugin as any)._stop;
    if (typeof fn === "function") fn();
  },
};

export default plugin;
