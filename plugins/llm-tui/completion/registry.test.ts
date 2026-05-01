import { describe, it, expect } from "bun:test";
import { makeCompletionRegistry, type CompletionSource } from "./registry.ts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CompletionRegistry", () => {
  it("register returns an unregister fn that removes the source", async () => {
    const r = makeCompletionRegistry({ debounceMs: 0 });
    const off = r.service.register({
      id: "a", trigger: "/",
      list: () => [{ label: "/help", insertText: "/help " }],
    });
    let items = await r.query("/", "");
    expect(items.map(i => i.label)).toEqual(["/help"]);
    off();
    items = await r.query("/", "");
    expect(items).toEqual([]);
  });

  it("merges items across multiple sources for the same trigger", async () => {
    const r = makeCompletionRegistry({ debounceMs: 0 });
    r.service.register({
      id: "a", trigger: "/",
      list: () => [{ label: "/zeta", insertText: "/zeta" }],
    });
    r.service.register({
      id: "b", trigger: "/",
      list: () => [{ label: "/alpha", insertText: "/alpha" }],
    });
    const items = await r.query("/", "");
    expect(items.map(i => i.label)).toEqual(["/alpha", "/zeta"]);
  });

  it("sorts by sortWeight desc, then label asc", async () => {
    const r = makeCompletionRegistry({ debounceMs: 0 });
    r.service.register({
      id: "a", trigger: "/",
      list: () => [
        { label: "/m", insertText: "/m", sortWeight: 1 },
        { label: "/z", insertText: "/z", sortWeight: 10 },
        { label: "/a", insertText: "/a", sortWeight: 1 },
      ],
    });
    const items = await r.query("/", "");
    expect(items.map(i => i.label)).toEqual(["/z", "/a", "/m"]);
  });

  it("ignores sources whose trigger differs from the active query trigger", async () => {
    const r = makeCompletionRegistry({ debounceMs: 0 });
    r.service.register({
      id: "slash", trigger: "/",
      list: () => [{ label: "/help", insertText: "/help" }],
    });
    r.service.register({
      id: "at", trigger: "@",
      list: () => [{ label: "@file", insertText: "@file" }],
    });
    expect((await r.query("/", "")).map(i => i.label)).toEqual(["/help"]);
    expect((await r.query("@", "")).map(i => i.label)).toEqual(["@file"]);
  });

  it("debounces successive query calls within the window", async () => {
    let calls = 0;
    const r = makeCompletionRegistry({ debounceMs: 30 });
    r.service.register({
      id: "a", trigger: "/",
      list: async () => { calls++; return [{ label: "/x", insertText: "/x" }]; },
    });
    void r.query("/", "a");
    void r.query("/", "ab");
    const items = await r.query("/", "abc");
    expect(items.map(i => i.label)).toEqual(["/x"]);
    expect(calls).toBe(1);
  });

  it("async source: stale result is discarded when query changes mid-flight", async () => {
    let release1: (v: any) => void = () => {};
    const slow1 = new Promise<any>((res) => { release1 = res; });
    const r = makeCompletionRegistry({ debounceMs: 0 });
    let phase = 0;
    r.service.register({
      id: "slow", trigger: "/",
      list: async (q: string) => {
        phase++;
        if (phase === 1) return slow1;
        return [{ label: `/fast-${q}`, insertText: `/fast-${q}` }];
      },
    });
    const p1 = r.query("/", "old");
    await tick(5);
    const p2 = r.query("/", "new");
    const fast = await p2;
    expect(fast.map(i => i.label)).toEqual(["/fast-new"]);
    // Now release the slow promise; p1 should not surface stale items.
    release1([{ label: "/stale", insertText: "/stale" }]);
    const stale = await p1;
    expect(stale).toEqual([]); // discarded
  });

  it("empty merged result is returned as []", async () => {
    const r = makeCompletionRegistry({ debounceMs: 0 });
    r.service.register({ id: "a", trigger: "/", list: () => [] });
    expect(await r.query("/", "x")).toEqual([]);
  });
});
