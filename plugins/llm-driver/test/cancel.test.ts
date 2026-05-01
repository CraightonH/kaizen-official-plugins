import { describe, it, expect, mock } from "bun:test";
import { wireCancel } from "../cancel.ts";
import type { CurrentTurn } from "../state.ts";

function makeCtx() {
  const handlers: Record<string, Function[]> = {};
  return {
    on: (name: string, fn: Function) => {
      (handlers[name] ??= []).push(fn);
      return () => {
        handlers[name] = (handlers[name] ?? []).filter(f => f !== fn);
      };
    },
    fire: async (name: string, payload?: any) => {
      for (const fn of handlers[name] ?? []) await fn(payload);
    },
    handlers,
  };
}

describe("wireCancel", () => {
  it("aborts the current turn on bare turn:cancel", async () => {
    const ctx = makeCtx();
    const ac = new AbortController();
    const current: { value: CurrentTurn | null } = { value: { id: "t1", controller: ac } };
    const teardown = wireCancel(ctx as any, () => current.value);
    expect(ac.signal.aborted).toBe(false);
    await ctx.fire("turn:cancel", {});
    expect(ac.signal.aborted).toBe(true);
    teardown();
  });

  it("ignores turn:cancel with non-matching turnId", async () => {
    const ctx = makeCtx();
    const ac = new AbortController();
    const current: { value: CurrentTurn | null } = { value: { id: "t1", controller: ac } };
    wireCancel(ctx as any, () => current.value);
    await ctx.fire("turn:cancel", { turnId: "other" });
    expect(ac.signal.aborted).toBe(false);
  });

  it("aborts on matching turnId", async () => {
    const ctx = makeCtx();
    const ac = new AbortController();
    const current: { value: CurrentTurn | null } = { value: { id: "t1", controller: ac } };
    wireCancel(ctx as any, () => current.value);
    await ctx.fire("turn:cancel", { turnId: "t1" });
    expect(ac.signal.aborted).toBe(true);
  });

  it("no-op when there is no current turn", async () => {
    const ctx = makeCtx();
    wireCancel(ctx as any, () => null);
    await expect(ctx.fire("turn:cancel", {})).resolves.toBeUndefined();
  });

  it("teardown removes the subscriber", async () => {
    const ctx = makeCtx();
    const ac = new AbortController();
    const current: { value: CurrentTurn | null } = { value: { id: "t1", controller: ac } };
    const teardown = wireCancel(ctx as any, () => current.value);
    teardown();
    await ctx.fire("turn:cancel", {});
    expect(ac.signal.aborted).toBe(false);
  });
});
