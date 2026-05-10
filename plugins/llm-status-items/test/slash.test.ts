import { describe, it, expect } from "bun:test";
import { registerStatusSlash, type SlashRegistryLike, type SlashCommandManifestLike, type SlashCommandContextLike } from "../slash.ts";
import type { StatusSnapshot } from "../snapshot.ts";

interface Registered {
  manifest: SlashCommandManifestLike;
  handler: (ctx: SlashCommandContextLike) => Promise<void>;
}

function makeFakeRegistry(): { reg: SlashRegistryLike; entries: Registered[] } {
  const entries: Registered[] = [];
  const reg: SlashRegistryLike = {
    register(manifest, handler) {
      entries.push({ manifest, handler });
      return () => {};
    },
  };
  return { reg, entries };
}

function fullSnapshot(): StatusSnapshot {
  return {
    model: "gpt-4o-mini",
    session: { id: "abc12345-6789-0000-0000-000000000000", alias: "demo" },
    contextWindow: { lastPromptTokens: 3421, contextLength: 8192, pctUsed: 3421 / 8192 },
    sessionTotals: { promptTokens: 12303, completionTokens: 2103 },
    tokensPerSec: 87.4,
    costCents: 1.23,
  };
}

async function invoke(snap: StatusSnapshot): Promise<string> {
  const { reg, entries } = makeFakeRegistry();
  registerStatusSlash(reg, () => snap);
  expect(entries.length).toBe(1);
  expect(entries[0]!.manifest.name).toBe("status:show");
  expect(entries[0]!.manifest.source).toBe("plugin");
  const printed: string[] = [];
  await entries[0]!.handler({ args: "", print: async (t) => { printed.push(t); } });
  expect(printed.length).toBe(1);
  return printed[0]!;
}

describe("/status:show slash adapter", () => {
  it("renders all fields when populated", async () => {
    const text = await invoke(fullSnapshot());
    expect(text).toContain("model:           gpt-4o-mini");
    expect(text).toContain("session:         abc12345-6789-0000-0000-000000000000 (demo)");
    expect(text).toContain("context window:  3,421 / 8,192  (42%)");
    expect(text).toContain("session totals:  in=12,303  out=2,103");
    expect(text).toContain("tok/s (last):    87.4");
    expect(text).toContain("cost (est):      $0.0123");
  });

  it("renders integer tok/s when >= 10", async () => {
    const snap = fullSnapshot();
    snap.tokensPerSec = 123.7;
    const text = await invoke(snap);
    expect(text).toContain("tok/s (last):    124");
  });

  it("formats session as id-only when alias is null", async () => {
    const snap = fullSnapshot();
    snap.session.alias = null;
    const text = await invoke(snap);
    expect(text).toContain("session:         abc12345-6789-0000-0000-000000000000");
    expect(text).not.toContain("(demo)");
  });

  it("omits session line when id is null", async () => {
    const snap = fullSnapshot();
    snap.session = { id: null, alias: null };
    const text = await invoke(snap);
    expect(text).not.toContain("session:");
  });

  it("omits model line when model is null", async () => {
    const snap = fullSnapshot();
    snap.model = null;
    const text = await invoke(snap);
    expect(text).not.toContain("model:");
  });

  it("omits ceiling and percentage when contextLength is null", async () => {
    const snap = fullSnapshot();
    snap.contextWindow = { lastPromptTokens: 3421, contextLength: null, pctUsed: null };
    const text = await invoke(snap);
    expect(text).toContain("context window:  3,421");
    expect(text).not.toContain(" / ");
    expect(text).not.toContain("%");
  });

  it("omits tok/s line when null", async () => {
    const snap = fullSnapshot();
    snap.tokensPerSec = null;
    const text = await invoke(snap);
    expect(text).not.toContain("tok/s");
  });

  it("omits cost line when null", async () => {
    const snap = fullSnapshot();
    snap.costCents = null;
    const text = await invoke(snap);
    expect(text).not.toContain("cost");
  });

  it("formats fractional cost correctly", async () => {
    const snap = fullSnapshot();
    snap.costCents = 0.5;       // half a cent → $0.0050
    const text = await invoke(snap);
    expect(text).toContain("cost (est):      $0.0050");
  });
});
