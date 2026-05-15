import { describe, it, expect, mock } from "bun:test";
import { registerSlashCommands, type SlashRegistryLike, type ApprovalState, type SlashDeps } from "../slash.ts";

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

function makeDeps(over: Partial<SlashDeps> = {}): SlashDeps {
  return {
    state: { paused: false },
    setStatus: () => {},
    rulesBySource: () => ({
      defaults: { allow: [], deny: [] },
      global: { allow: [], deny: [] },
      project: { allow: [], deny: [] },
    }),
    writeTarget: () => "/home/u/.kaizen/plugins/llm-tool-approval/config.json",
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

  it("approval:status prints pause state + per-source counts + merged + target", async () => {
    const { reg, registered } = makeRegistry();
    const deps = makeDeps({
      rulesBySource: () => ({
        defaults: { allow: ["x"], deny: [] },
        global:   { allow: ["y"], deny: ["bad"] },
        project:  { allow: ["x", "z"], deny: [] },
      }),
      writeTarget: () => "/proj/.kaizen/plugins/llm-tool-approval/config.json",
    });
    registerSlashCommands(reg, deps);
    const status = registered.find((r) => r.manifest.name === "approval:status")!.handler;
    const out = (await callHandler(status)).join("\n");
    expect(out).toContain("paused: false");
    expect(out).toContain("defaults: 1 allow, 0 deny");
    expect(out).toContain("global: 1 allow, 1 deny");
    expect(out).toContain("project: 2 allow, 0 deny");
    expect(out).toContain("/proj/.kaizen/plugins/llm-tool-approval/config.json");
    expect(out).toMatch(/effective allow.*x.*y.*z/);
    expect(out).toContain("effective deny");
  });
});
