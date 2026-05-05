import type { KaizenPlugin } from "kaizen/types";
import type { LLMCompleteService, ModelInfo } from "llm-events/public";
import { applyEvent, initialState, type StatusState } from "./state.ts";
import { formatDollars, loadRateTable, realCostDeps, tokensToCents, type CostDeps, type RateTable } from "./cost.ts";
import { formatContextItem } from "./context.ts";

const SUBSCRIBED = [
  "session:start",
  "llm:before-call",
  "llm:done",
  "turn:start",
  "turn:end",
  "tool:before-execute",
  "tool:result",
  "tool:error",
  "conversation:cleared",
] as const;

const plugin: KaizenPlugin = {
  name: "llm-status-items",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { consumes: ["llm-events:vocabulary", "llm:complete"] },

  async setup(ctx) {
    ctx.consumeService("llm-events:vocabulary");
    // Consumed lazily — listModels() only runs the first time we see a
    // model id at runtime, by which point the provider has registered.
    ctx.consumeService("llm:complete");

    // Cost deps come from a private test hook on ctx, falling back to the real fs.
    // (`_testCostDeps` is only set by tests; production code never reads it.)
    const costDeps: CostDeps = (ctx as any)._testCostDeps ?? realCostDeps();
    const rates: RateTable = await loadRateTable(costDeps);
    const hasAnyRate = Object.keys(rates).length > 0;

    let state: StatusState = initialState();
    let costCents = 0;
    let costActive = false; // becomes true after first successful cost emission; controls whether to clear on conversation:cleared
    // Flips on the first session:start. Lets emitDiff render zero token
    // counters and the empty context bar before any turn has run, so the
    // status line isn't half-empty at idle.
    let initialized = false;

    let lastEmitted = {
      model: null as string | null,
      tokensIn: null as string | null,
      tokensOut: null as string | null,
      tokensPerSec: null as string | null,
      turnState: null as string | null,
      cost: null as string | null,
      ctx: null as string | null,
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
      try { llm = ctx.useService<LLMCompleteService>("llm:complete") ?? null; } catch { llm = null; }
      modelsListed = true;
      if (!llm) return;
      try {
        const models: ModelInfo[] = await llm.listModels();
        for (const m of models) {
          const ceiling = m.loadedContextLength ?? m.maxContextLength ?? m.contextLength ?? null;
          contextCache.set(m.id, ceiling);
          if (m.loadedContextLength != null && ambientLoadedCeiling === null) {
            ambientLoadedCeiling = m.loadedContextLength;
            ambientLoadedModelId = m.id;
          }
        }
      } catch {
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
      // model
      if (state.model && state.model !== lastEmitted.model) {
        await ctx.emit("status:item-update", { key: "model", value: state.model });
        lastEmitted.model = state.model;
      }
      // tokens — show in / out separately. Total was redundant (the user can
      // sum two numbers) and cluttered the bar; the ctx item now carries the
      // signal about how much room is left in the window.
      const inV = String(state.promptTokens);
      const outV = String(state.completionTokens);
      // Once we've initialized (after session:start), surface zeros too —
      // an empty status line is worse than visible defaults.
      const haveTokens = initialized || state.promptTokens > 0 || state.completionTokens > 0;
      if (state.cleared) {
        for (const key of ["in", "out", "tok/s"] as const) {
          const slot = key === "in" ? "tokensIn" : key === "out" ? "tokensOut" : "tokensPerSec";
          if (lastEmitted[slot] !== null) {
            await ctx.emit("status:item-clear", { key });
          }
        }
        lastEmitted.tokensIn = lastEmitted.tokensOut = lastEmitted.tokensPerSec = null;
      } else if (haveTokens) {
        if (inV !== lastEmitted.tokensIn) {
          await ctx.emit("status:item-update", { key: "in", value: inV });
          lastEmitted.tokensIn = inV;
        }
        if (outV !== lastEmitted.tokensOut) {
          await ctx.emit("status:item-update", { key: "out", value: outV });
          lastEmitted.tokensOut = outV;
        }
      }
      // tok/s — show 0 before the first measurement so the slot is visible.
      const tpsValue = state.tokensPerSec === null
        ? (initialized ? "0" : null)
        : state.tokensPerSec >= 10
          ? state.tokensPerSec.toFixed(0)
          : state.tokensPerSec.toFixed(1);
      if (tpsValue !== null && tpsValue !== lastEmitted.tokensPerSec) {
        await ctx.emit("status:item-update", { key: "tok/s", value: tpsValue });
        lastEmitted.tokensPerSec = tpsValue;
      }
      // turn-state
      if (state.turnState !== lastEmitted.turnState) {
        await ctx.emit("status:item-update", { key: "turn-state", value: state.turnState });
        lastEmitted.turnState = state.turnState;
      }
      // context window — only renderable once we know the ceiling AND have
      // a prompt-token sample. State.cleared resets both, so the cleared
      // branch above already covers the clear case.
      if (state.cleared && lastEmitted.ctx !== null) {
        await ctx.emit("status:item-clear", { key: "_ctx" });
        lastEmitted.ctx = null;
      } else if (state.contextLength) {
        // Render with zero used before any call has been made. Keeps the bar
        // visible from session:start instead of waiting for first llm:done.
        const value = formatContextItem(state.lastPromptTokens, state.contextLength);
        if (value !== lastEmitted.ctx) {
          await ctx.emit("status:item-update", { key: "_ctx", value });
          lastEmitted.ctx = value;
        }
      }
    }

    async function emitCost(eventName: string, payload: any) {
      if (!hasAnyRate) return; // fully local — never emit cost-estimate
      if (eventName === "conversation:cleared") {
        costCents = 0;
        if (costActive) {
          await ctx.emit("status:item-clear", { key: "cost-estimate" });
          lastEmitted.cost = null;
          costActive = false;
        }
        return;
      }
      if (eventName !== "llm:done") return;
      const usage = payload?.response?.usage;
      if (!usage || !state.model) return;
      const inc = tokensToCents(rates, state.model, usage);
      if (inc === null) {
        // Model not in table — clear any prior cost-estimate.
        if (costActive) {
          await ctx.emit("status:item-clear", { key: "cost-estimate" });
          lastEmitted.cost = null;
          costActive = false;
        }
        return;
      }
      costCents += inc;
      const display = formatDollars(costCents);
      if (display !== lastEmitted.cost) {
        await ctx.emit("status:item-update", { key: "cost-estimate", value: display });
        lastEmitted.cost = display;
        costActive = true;
      }
    }

    for (const name of SUBSCRIBED) {
      ctx.on(name, async (payload: any) => {
        state = applyEvent(state, name, payload);
        // session:start: probe the provider once so the bar can render
        // model + ctx before any turn runs, and flip `initialized` so
        // zero-valued counters appear instead of being suppressed.
        // llm:before-call / llm:done: same probe in case session:start
        // landed before the provider service was available.
        if (state.contextLength === null && (name === "session:start" || name === "llm:before-call" || name === "llm:done")) {
          const ceiling = await resolveCeiling(state.model);
          if (ceiling !== null) state = { ...state, contextLength: ceiling };
          if (!state.model && ambientLoadedModelId) {
            state = { ...state, model: ambientLoadedModelId };
          }
        }
        if (name === "session:start") initialized = true;
        await emitDiff();
        await emitCost(name, payload);
      });
    }
  },
};

export default plugin;
