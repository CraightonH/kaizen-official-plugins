import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStore } from "../store.ts";
import { registerSlashCommands, type SlashRegistryLike, type SlashCommandContextLike } from "../slash.ts";

function fakeRegistry() {
  const handlers: Record<string, (ctx: SlashCommandContextLike) => Promise<void>> = {};
  const reg: SlashRegistryLike = {
    register(manifest, handler) {
      handlers[manifest.name] = handler;
      return () => { delete handlers[manifest.name]; };
    },
  };
  return { reg, handlers };
}

function fakeCtx(args: string | string[] = ""): SlashCommandContextLike & { output: string[]; errors: string[] } {
  const out: string[] = [];
  const errs: string[] = [];
  return {
    args: Array.isArray(args) ? args.join(" ") : String(args),
    print(text: string) { out.push(text); },
    error(text: string) { errs.push(text); },
    output: out,
    errors: errs,
  };
}

const sample = () => ({
  id: "a1", statement: "S", premises: ["p"], reasoning: "r", scope: "default",
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llm-axioms-slash-")); });

describe("axioms:list", () => {
  it("renders empty state when no axioms", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerSlashCommands(reg, s);
    const ctx = fakeCtx();
    await handlers["axioms:list"](ctx);
    expect(ctx.output.join("\n")).toMatch(/no axioms/i);
  });
  it("renders axioms grouped by scope with id and statement", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    await s.record({ ...sample(), id: "u1", statement: "UX truth", scope: "UX" });
    await s.record({ ...sample(), id: "a1", statement: "Auth truth", scope: "Auth" });
    const { reg, handlers } = fakeRegistry();
    registerSlashCommands(reg, s);
    const ctx = fakeCtx();
    await handlers["axioms:list"](ctx);
    const text = ctx.output.join("\n");
    expect(text).toContain("UX");
    expect(text).toContain("u1");
    expect(text).toContain("UX truth");
    expect(text).toContain("Auth");
    expect(text).toContain("a1");
  });
});

describe("axioms:show", () => {
  it("prints full detail for a known id", async () => {
    const s = makeStore({ axiomsDir: dir, now: () => 1700000000000 });
    await s.swapSession("sess-1");
    await s.record(sample());
    const { reg, handlers } = fakeRegistry();
    registerSlashCommands(reg, s);
    const ctx = fakeCtx("a1");
    await handlers["axioms:show"](ctx);
    const text = ctx.output.join("\n");
    expect(text).toContain("a1");
    expect(text).toContain("S");
    expect(text).toContain("p");
    expect(text).toContain("r");
    expect(text).toContain("default");
  });
  it("errors on missing id arg", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerSlashCommands(reg, s);
    const ctx = fakeCtx("");
    await handlers["axioms:show"](ctx);
    expect(ctx.errors.length).toBeGreaterThan(0);
  });
  it("errors on unknown id", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerSlashCommands(reg, s);
    const ctx = fakeCtx("ghost");
    await handlers["axioms:show"](ctx);
    expect(ctx.errors.length).toBeGreaterThan(0);
  });
});

describe("axioms:clear", () => {
  it("clears all axioms in the current session", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    await s.record(sample());
    await s.record({ ...sample(), id: "a2" });
    const { reg, handlers } = fakeRegistry();
    registerSlashCommands(reg, s);
    const ctx = fakeCtx();
    await handlers["axioms:clear"](ctx);
    expect(s.list().length).toBe(0);
    expect(ctx.output.join("\n")).toMatch(/cleared/i);
  });
  it("prints a notice when there's nothing to clear", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerSlashCommands(reg, s);
    const ctx = fakeCtx();
    await handlers["axioms:clear"](ctx);
    expect(ctx.output.join("\n")).toMatch(/no axioms/i);
  });
});
