import type { KaizenPlugin } from "kaizen/types";
import { applyEvent, initialState, type StatusState } from "./state.ts";
import { formatDollars, loadRateTable, realCostDeps, tokensToCents, type CostDeps, type RateTable } from "./cost.ts";

const SUBSCRIBED = [
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
  services: { consumes: ["llm-events:vocabulary"] },

  async setup(ctx) {
    ctx.consumeService("llm-events:vocabulary");

    // Cost deps come from a private test hook on ctx, falling back to the real fs.
    // (`_testCostDeps` is only set by tests; production code never reads it.)
    const costDeps: CostDeps = (ctx as any)._testCostDeps ?? realCostDeps();
    const rates: RateTable = await loadRateTable(costDeps);
    const hasAnyRate = Object.keys(rates).length > 0;

    let state: StatusState = initialState();
    let costCents = 0;
    let costActive = false; // becomes true after first successful cost emission; controls whether to clear on conversation:cleared

    let lastEmitted = {
      model: null as string | null,
      tokensIn: null as string | null,
      tokensOut: null as string | null,
      tokensTotal: null as string | null,
      tokensPerSec: null as string | null,
      turnState: null as string | null,
      cost: null as string | null,
    };

    async function emitDiff() {
      // model
      if (state.model && state.model !== lastEmitted.model) {
        await ctx.emit("status:item-update", { key: "model", value: state.model });
        lastEmitted.model = state.model;
      }
      // tokens — separate in / out / total status items so the bar reads
      // clearly (no math, no ambiguity about which number is which).
      const inV = String(state.promptTokens);
      const outV = String(state.completionTokens);
      const totalV = String(state.promptTokens + state.completionTokens);
      const haveTokens = state.promptTokens > 0 || state.completionTokens > 0;
      if (state.cleared) {
        for (const key of ["in", "out", "total", "tok/s"] as const) {
          if (lastEmitted[key === "in" ? "tokensIn" : key === "out" ? "tokensOut" : key === "total" ? "tokensTotal" : "tokensPerSec"] !== null) {
            await ctx.emit("status:item-clear", { key });
          }
        }
        lastEmitted.tokensIn = lastEmitted.tokensOut = lastEmitted.tokensTotal = lastEmitted.tokensPerSec = null;
      } else if (haveTokens) {
        if (inV !== lastEmitted.tokensIn) {
          await ctx.emit("status:item-update", { key: "in", value: inV });
          lastEmitted.tokensIn = inV;
        }
        if (outV !== lastEmitted.tokensOut) {
          await ctx.emit("status:item-update", { key: "out", value: outV });
          lastEmitted.tokensOut = outV;
        }
        if (totalV !== lastEmitted.tokensTotal) {
          await ctx.emit("status:item-update", { key: "total", value: totalV });
          lastEmitted.tokensTotal = totalV;
        }
      }
      if (state.tokensPerSec !== null) {
        const tps = state.tokensPerSec >= 10
          ? state.tokensPerSec.toFixed(0)
          : state.tokensPerSec.toFixed(1);
        if (tps !== lastEmitted.tokensPerSec) {
          await ctx.emit("status:item-update", { key: "tok/s", value: tps });
          lastEmitted.tokensPerSec = tps;
        }
      }
      // turn-state
      if (state.turnState !== lastEmitted.turnState) {
        await ctx.emit("status:item-update", { key: "turn-state", value: state.turnState });
        lastEmitted.turnState = state.turnState;
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
        await emitDiff();
        await emitCost(name, payload);
      });
    }
  },
};

export default plugin;
