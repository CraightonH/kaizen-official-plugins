import { describe, it, expect } from "bun:test";
import plugin from "../../index.ts";
import type { LLMCompleteService } from "llm-events/public";

const RUN = process.env.KAIZEN_INTEGRATION === "1";

(RUN ? describe : describe.skip)("live LM Studio @ localhost:1234", () => {
  it("streams a one-turn chat", async () => {
    let svcImpl: any = null;
    const ctx: any = {
      log: console.log,
      defineService: () => {},
      provideService: (_n: string, impl: any) => { svcImpl = impl; },
    };
    await plugin.setup(ctx);
    const svc = svcImpl as LLMCompleteService;
    const events: any[] = [];
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30000);
    for await (const e of svc.complete({ model: "", messages: [{ role: "user", content: "Say only: ok" }] }, { signal: ac.signal })) {
      events.push(e);
      if (events.length > 200) ac.abort();
    }
    expect(events.find(e => e.type === "done")).toBeTruthy();
  }, 35000);
});
