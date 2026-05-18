import { describe, it, expect, mock } from "bun:test";
import { registerSlashCommands, type SlashRegistryLike, type SlashDeps } from "../slash.ts";
import type { ConfigStatus } from "llm-contracts/public";

function makeRegistry() {
  const registered: { manifest: any; handler: any }[] = [];
  const reg: SlashRegistryLike = {
    register(manifest, handler) {
      registered.push({ manifest, handler });
      return () => {
        const idx = registered.findIndex((r) => r.manifest.name === manifest.name);
        if (idx >= 0) registered.splice(idx, 1);
      };
    },
  };
  return { reg, registered };
}

interface FakeStoreOpts {
  effective?: { allow: string[]; deny: string[] };
  status?: Partial<ConfigStatus>;
}

function makeCfgSvc(opts: FakeStoreOpts = {}): SlashDeps["cfgSvc"] {
  const effective = opts.effective ?? { allow: [], deny: [] };
  const baseStatus: ConfigStatus = {
    plugin: "llm-tool-approval",
    homePath: "/home/u/.kaizen/harnesses/openai-compatible/config.json",
    projectPath: "/proj/.kaizen/harnesses/openai-compatible/config.json",
    homeExists: false,
    projectExists: false,
    resolution: { allow: "default", deny: "default" },
    ...(opts.status ?? {}),
  };
  return {
    get: <T,>(_plugin: string): T => effective as unknown as T,
    list: () => [baseStatus],
  };
}

function makeDeps(over: Partial<SlashDeps> = {}): SlashDeps {
  return {
    state: { paused: false },
    setStatus: () => {},
    cfgSvc: makeCfgSvc(),
    ...over,
  };
}

const callHandler = async (handler: any, args = "") => {
  const printed: string[] = [];
  await handler({ args, print: async (t: string) => { printed.push(t); } });
  return printed;
};

describe("registerSlashCommands", () => {
  it("registers approval:pause, approval:resume, approval:status", () => {
    const { reg, registered } = makeRegistry();
    const deps = makeDeps();
    registerSlashCommands(reg, deps);
    const names = registered.map((r) => r.manifest.name).sort();
    expect(names).toEqual(["approval:pause", "approval:resume", "approval:status"]);
    expect(registered.every((r) => r.manifest.source === "plugin")).toBe(true);
  });

  it("approval:pause sets paused=true and updates status", async () => {
    const { reg, registered } = makeRegistry();
    const setStatus = mock(() => {});
    const deps = makeDeps({ setStatus });
    registerSlashCommands(reg, deps);
    const pause = registered.find((r) => r.manifest.name === "approval:pause")!.handler;
    const out = await callHandler(pause);
    expect(deps.state.paused).toBe(true);
    expect(setStatus).toHaveBeenCalledWith("paused");
    expect(out.join("\n")).toContain("paused");
  });

  it("approval:resume sets paused=false and updates status", async () => {
    const { reg, registered } = makeRegistry();
    const setStatus = mock(() => {});
    const deps = makeDeps({ setStatus });
    deps.state.paused = true;
    registerSlashCommands(reg, deps);
    const resume = registered.find((r) => r.manifest.name === "approval:resume")!.handler;
    const out = await callHandler(resume);
    expect(deps.state.paused).toBe(false);
    expect(setStatus).toHaveBeenCalledWith("request");
    expect(out.join("\n")).toContain("active");
  });

  it("approval:pause is idempotent (already paused → still paused)", async () => {
    const { reg, registered } = makeRegistry();
    const deps = makeDeps();
    deps.state.paused = true;
    registerSlashCommands(reg, deps);
    const pause = registered.find((r) => r.manifest.name === "approval:pause")!.handler;
    await callHandler(pause);
    expect(deps.state.paused).toBe(true);
  });

  it("approval:status prints pause state, effective rules, resolution + write target", async () => {
    const { reg, registered } = makeRegistry();
    const cfgSvc = makeCfgSvc({
      effective: { allow: ["x", "y", "z"], deny: ["bad"] },
      status: {
        homeExists: true,
        projectExists: true,
        resolution: { allow: "project", deny: "home" },
        homePath: "/home/u/.kaizen/harnesses/openai-compatible/config.json",
        projectPath: "/proj/.kaizen/harnesses/openai-compatible/config.json",
      },
    });
    const deps = makeDeps({ cfgSvc });
    registerSlashCommands(reg, deps);
    const status = registered.find((r) => r.manifest.name === "approval:status")!.handler;
    const out = (await callHandler(status)).join("\n");
    expect(out).toContain("paused: false");
    expect(out).toContain("effective allow (3)");
    expect(out).toContain("x, y, z");
    expect(out).toContain("effective deny (1)");
    expect(out).toContain("bad");
    expect(out).toContain("allow: project");
    expect(out).toContain("deny: home");
    expect(out).toContain("/proj/.kaizen/harnesses/openai-compatible/config.json");
  });

  it("approval:status with no files reports (none) for home/project paths", async () => {
    const { reg, registered } = makeRegistry();
    const cfgSvc = makeCfgSvc({
      effective: { allow: [], deny: [] },
      status: { homeExists: false, projectExists: false },
    });
    const deps = makeDeps({ cfgSvc });
    registerSlashCommands(reg, deps);
    const status = registered.find((r) => r.manifest.name === "approval:status")!.handler;
    const out = (await callHandler(status)).join("\n");
    expect(out).toContain("home: (none)");
    expect(out).toContain("project: (none)");
    expect(out).toContain("effective allow (0): (none)");
    expect(out).toContain("effective deny (0): (none)");
  });
});
