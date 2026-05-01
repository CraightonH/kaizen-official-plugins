import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadRateTable, tokensToCents, formatDollars, type CostDeps } from "../cost.ts";

const FIXTURE = resolve(import.meta.dir, "fixtures/cost-table.json");

function makeDeps(overrides: Partial<CostDeps> = {}): CostDeps {
  return {
    home: "/home/u",
    readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    ...overrides,
  };
}

describe("loadRateTable", () => {
  it("returns empty rates when file is absent", async () => {
    const t = await loadRateTable(makeDeps());
    expect(t).toEqual({});
  });

  it("loads rates from a real file", async () => {
    const t = await loadRateTable(makeDeps({ readFile: () => readFile(FIXTURE, "utf8") }));
    expect(t["gpt-4.1-mini"]).toEqual({ promptCentsPerMTok: 15, completionCentsPerMTok: 60 });
    expect(t["gpt-4.1"]).toEqual({ promptCentsPerMTok: 200, completionCentsPerMTok: 800 });
  });

  it("throws on malformed JSON", async () => {
    await expect(
      loadRateTable(makeDeps({ readFile: async () => "{not-json" })),
    ).rejects.toThrow(/llm-status-items.*cost-table.*malformed/i);
  });

  it("uses ~/.kaizen/plugins/llm-status-items/cost-table.json by default", async () => {
    let path = "";
    await loadRateTable(makeDeps({
      readFile: async (p: string) => { path = p; return JSON.stringify({ rates: {} }); },
    }));
    expect(path).toBe("/home/u/.kaizen/plugins/llm-status-items/cost-table.json");
  });
});

describe("tokensToCents", () => {
  const rates = {
    "gpt-4.1-mini": { promptCentsPerMTok: 15, completionCentsPerMTok: 60 },
  };

  it("returns null when model is missing", () => {
    expect(tokensToCents(rates, "unknown-model", { promptTokens: 100, completionTokens: 50 })).toBeNull();
  });

  it("computes cents for known model", () => {
    // 1_000_000 prompt @ 15 cents = 15 cents; 1_000_000 completion @ 60 cents = 60 cents
    expect(tokensToCents(rates, "gpt-4.1-mini", { promptTokens: 1_000_000, completionTokens: 1_000_000 })).toBeCloseTo(75, 6);
  });

  it("scales linearly", () => {
    expect(tokensToCents(rates, "gpt-4.1-mini", { promptTokens: 100, completionTokens: 50 })).toBeCloseTo(
      (100 * 15 + 50 * 60) / 1_000_000, 9,
    );
  });
});

describe("formatDollars", () => {
  it("formats cents with 4 decimal places", () => {
    expect(formatDollars(0)).toBe("$0.0000");
    expect(formatDollars(1.23)).toBe("$0.0123");
    expect(formatDollars(12345)).toBe("$123.4500");
  });
});
