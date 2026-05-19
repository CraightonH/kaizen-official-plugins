import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStore } from "../store.ts";
import { registerTools, type ToolsRegistryLike } from "../tools.ts";

function fakeRegistry() {
  const handlers: Record<string, { schema: any; handler: (args: any, ctx: any) => Promise<unknown> }> = {};
  const reg: ToolsRegistryLike = {
    register(schema, handler) {
      handlers[schema.name] = { schema, handler };
      return () => { delete handlers[schema.name]; };
    },
  };
  return { reg, handlers };
}

const sample = () => ({
  id: "a1", statement: "S", premises: ["p"], reasoning: "r", scope: "default",
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llm-axioms-tools-")); });

describe("registerTools", () => {
  it("registers axiom_record / axiom_amend / axiom_drop", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    expect(Object.keys(handlers).sort()).toEqual(["axiom_amend", "axiom_drop", "axiom_record"]);
  });
  it("each tool is tagged ['axioms', 'write']", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    for (const name of ["axiom_record", "axiom_amend", "axiom_drop"]) {
      expect(handlers[name].schema.tags).toEqual(["axioms", "write"]);
    }
  });
});

describe("axiom_record handler", () => {
  it("happy path returns { ok: true, axiom }", async () => {
    const s = makeStore({ axiomsDir: dir, now: () => 1234 });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    const out = await handlers.axiom_record.handler(sample(), {});
    expect(out).toMatchObject({ ok: true, axiom: { id: "a1", derivedAt: 1234 } });
  });
  it("duplicate id returns structured error", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    await handlers.axiom_record.handler(sample(), {});
    const out = await handlers.axiom_record.handler(sample(), {});
    expect(out).toMatchObject({ ok: false, error: "axiom_exists" });
  });
  it("invalid id returns structured error", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    const out = await handlers.axiom_record.handler({ ...sample(), id: "BAD" }, {});
    expect(out).toMatchObject({ ok: false, error: "invalid_id" });
  });
  it("no active session returns structured error", async () => {
    const s = makeStore({ axiomsDir: dir });
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    const out = await handlers.axiom_record.handler(sample(), {});
    expect(out).toMatchObject({ ok: false, error: "no_active_session" });
  });
});

describe("axiom_amend handler", () => {
  it("amends an existing axiom", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    await handlers.axiom_record.handler(sample(), {});
    const out = await handlers.axiom_amend.handler({ id: "a1", statement: "S2" }, {});
    expect(out).toMatchObject({ ok: true, axiom: { statement: "S2" } });
  });
  it("requires at least one patch field", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    await handlers.axiom_record.handler(sample(), {});
    const out = await handlers.axiom_amend.handler({ id: "a1" }, {});
    expect(out).toMatchObject({ ok: false, error: "no_patch_fields" });
  });
  it("unknown id returns structured error", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    const out = await handlers.axiom_amend.handler({ id: "ghost", statement: "x" }, {});
    expect(out).toMatchObject({ ok: false, error: "axiom_not_found" });
  });
});

describe("axiom_drop handler", () => {
  it("drops with a reason", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    await handlers.axiom_record.handler(sample(), {});
    const out = await handlers.axiom_drop.handler({ id: "a1", reason: "superseded" }, {});
    expect(out).toMatchObject({ ok: true, droppedId: "a1", reason: "superseded" });
  });
  it("rejects without a reason", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    await handlers.axiom_record.handler(sample(), {});
    const out = await handlers.axiom_drop.handler({ id: "a1", reason: "" }, {});
    expect(out).toMatchObject({ ok: false, error: "invalid_reason" });
  });
  it("unknown id returns structured error", async () => {
    const s = makeStore({ axiomsDir: dir });
    await s.swapSession("sess-1");
    const { reg, handlers } = fakeRegistry();
    registerTools(reg, s);
    const out = await handlers.axiom_drop.handler({ id: "ghost", reason: "x" }, {});
    expect(out).toMatchObject({ ok: false, error: "axiom_not_found" });
  });
});
