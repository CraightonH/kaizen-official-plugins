import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.ts";
import { buildFixtures, type FixtureSet } from "./fixtures.ts";

let fixtureRoot: string;
let fixtures: FixtureSet;

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "llm-env-index-"));
  fixtures = buildFixtures(fixtureRoot);
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

interface SectionReg {
  id: string;
  priority: number;
  title?: string;
  render(): Promise<string> | string;
  generationBumps: number;
  unregistered: boolean;
}

interface SlashReg {
  manifest: { name: string; description: string; source?: string };
  unregistered: boolean;
}

interface ToolReg {
  schema: { name: string };
  source: { kind: string };
  unregistered: boolean;
}

function makeFakeCtx(opts: { slash?: boolean; tools?: boolean; cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const slashOn = opts.slash ?? true;
  const toolsOn = opts.tools ?? true;
  const sections: SectionReg[] = [];
  const slashRegs: SlashReg[] = [];
  const toolRegs: ToolReg[] = [];
  const logs: string[] = [];

  const promptRegistry = {
    register(section: { id: string; priority: number; title?: string; render(): Promise<string> | string }) {
      const reg: SectionReg = { ...section, generationBumps: 0, unregistered: false };
      sections.push(reg);
      return {
        bumpGeneration: () => { reg.generationBumps += 1; },
        unregister: () => { reg.unregistered = true; },
      };
    },
  };

  const slashRegistry = {
    register(manifest: { name: string; description: string; source?: string }, _h: unknown) {
      const r: SlashReg = { manifest, unregistered: false };
      slashRegs.push(r);
      return () => { r.unregistered = true; };
    },
    get: () => undefined,
    list: () => [],
  };

  const toolsRegistry = {
    register: () => () => {},
    registerWith(reg: { schema: { name: string }; handler: unknown; source: { kind: string } }) {
      const r: ToolReg = { schema: reg.schema, source: reg.source, unregistered: false };
      toolRegs.push(r);
      return () => { r.unregistered = true; };
    },
    list: () => [],
    listRegistrations: () => [],
    invoke: async () => undefined,
  };

  const ctx = {
    cwd: opts.cwd ?? fixtures.nonGit,
    env: opts.env ?? {},
    log: (m: string) => { logs.push(m); },
    provideService: () => {},
    consumeService: () => {},
    useService: (n: string) => {
      if (n === "prompt:registry") return promptRegistry;
      if (n === "slash:registry") {
        if (slashOn) return slashRegistry;
        throw new Error("missing service slash:registry");
      }
      if (n === "tools:registry") {
        if (toolsOn) return toolsRegistry;
        throw new Error("missing service tools:registry");
      }
      throw new Error(`missing service ${n}`);
    },
    emit: async () => {},
    on: () => {},
  };

  return { ctx: ctx as never, sections, slashRegs, toolRegs, logs };
}

describe("llm-environment plugin", () => {
  it("registers section at priority 30 with title Environment", async () => {
    const f = makeFakeCtx();
    await plugin.setup!(f.ctx);
    expect(f.sections.length).toBe(1);
    expect(f.sections[0]!.id).toBe("llm-environment:env");
    expect(f.sections[0]!.priority).toBe(30);
    expect(f.sections[0]!.title).toBe("Environment");
    await plugin.stop!();
  });

  it("registers /env:refresh when slash:registry is present", async () => {
    const f = makeFakeCtx({ slash: true });
    await plugin.setup!(f.ctx);
    expect(f.slashRegs.length).toBe(1);
    expect(f.slashRegs[0]!.manifest.name).toBe("env:refresh");
    await plugin.stop!();
  });

  it("registers environment_refresh tool when tools:registry is present", async () => {
    const f = makeFakeCtx({ tools: true });
    await plugin.setup!(f.ctx);
    expect(f.toolRegs.length).toBe(1);
    expect(f.toolRegs[0]!.schema.name).toBe("environment_refresh");
    expect(f.toolRegs[0]!.source.kind).toBe("local");
    await plugin.stop!();
  });

  it("survives when slash:registry and tools:registry are absent", async () => {
    const f = makeFakeCtx({ slash: false, tools: false });
    await plugin.setup!(f.ctx);
    expect(f.sections.length).toBe(1);
    expect(f.slashRegs.length).toBe(0);
    expect(f.toolRegs.length).toBe(0);
    await plugin.stop!();
  });

  it("stop() unregisters section, slash, and tool; second call is a no-op", async () => {
    const f = makeFakeCtx();
    await plugin.setup!(f.ctx);
    await plugin.stop!();
    expect(f.sections[0]!.unregistered).toBe(true);
    expect(f.slashRegs[0]!.unregistered).toBe(true);
    expect(f.toolRegs[0]!.unregistered).toBe(true);
    await plugin.stop!();
  });
});
