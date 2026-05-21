import { describe, it, expect, mock } from "bun:test";
import { persistProjectAllow, type PersistDeps } from "../persist.ts";

function makeDeps(over: Partial<PersistDeps> & {
  projectExists?: boolean;
  projectPath?: string;
  fileContents?: string;
  readError?: Error;
} = {}): {
  deps: PersistDeps;
  writes: Array<{ plugin: string; value: { allow: string[] }; scope: "home" | "project" }>;
  logs: string[];
} {
  const writes: Array<{ plugin: string; value: { allow: string[] }; scope: "home" | "project" }> = [];
  const logs: string[] = [];
  const projectPath = over.projectPath ?? "/fake/project/.kaizen/harnesses/k/config.json";
  const projectExists = over.projectExists ?? true;
  const readFileFn = over.readFileFn ?? (async (p: string) => {
    if (over.readError) throw over.readError;
    if (p !== projectPath) throw new Error(`unexpected read of ${p}`);
    return over.fileContents ?? "{}";
  });
  const deps: PersistDeps = {
    cfgSvc: {
      list: () => [{ plugin: "llm-tool-approval", projectPath, projectExists }],
      set: async (plugin, value, scope) => { writes.push({ plugin, value: value as { allow: string[] }, scope }); },
    },
    readFileFn,
    log: (msg) => { logs.push(msg); },
    ...over,
  };
  return { deps, writes, logs };
}

describe("persistProjectAllow", () => {
  it("writes only the project-scope delta + the new entry (does not include defaults from merged view)", async () => {
    const { deps, writes } = makeDeps({
      fileContents: JSON.stringify({
        plugins: { "llm-tool-approval": { allow: ["bash"] } },
      }),
    });
    await persistProjectAllow("llm-tool-approval", "read", deps);
    expect(writes).toEqual([
      { plugin: "llm-tool-approval", value: { allow: ["bash", "read"] }, scope: "project" },
    ]);
  });

  it("when the project file does not exist, persists ONLY the new entry (not the merged defaults)", async () => {
    const readSpy = mock(async () => "{}");
    const { deps, writes } = makeDeps({ projectExists: false, readFileFn: readSpy });
    await persistProjectAllow("llm-tool-approval", "bash", deps);
    expect(readSpy).not.toHaveBeenCalled();
    expect(writes).toEqual([
      { plugin: "llm-tool-approval", value: { allow: ["bash"] }, scope: "project" },
    ]);
  });

  it("dedupes and sorts the written allow list", async () => {
    const { deps, writes } = makeDeps({
      fileContents: JSON.stringify({
        plugins: { "llm-tool-approval": { allow: ["read", "bash"] } },
      }),
    });
    await persistProjectAllow("llm-tool-approval", "bash", deps);
    expect(writes[0]?.value.allow).toEqual(["bash", "read"]);
  });

  it("tolerates a missing plugin entry in the project file", async () => {
    const { deps, writes } = makeDeps({ fileContents: JSON.stringify({ plugins: {} }) });
    await persistProjectAllow("llm-tool-approval", "bash", deps);
    expect(writes[0]?.value.allow).toEqual(["bash"]);
  });

  it("tolerates non-string entries in the project file (filters them out)", async () => {
    const { deps, writes } = makeDeps({
      fileContents: JSON.stringify({
        plugins: { "llm-tool-approval": { allow: ["bash", 42, null, "read"] } },
      }),
    });
    await persistProjectAllow("llm-tool-approval", "glob", deps);
    expect(writes[0]?.value.allow).toEqual(["bash", "glob", "read"]);
  });

  it("logs and recovers when the project file is malformed JSON (writes just the new entry)", async () => {
    const { deps, writes, logs } = makeDeps({ fileContents: "{ not json" });
    await persistProjectAllow("llm-tool-approval", "bash", deps);
    expect(writes[0]?.value.allow).toEqual(["bash"]);
    expect(logs.some((l) => l.includes("could not read project config"))).toBe(true);
  });

  it("logs and recovers when the file read itself fails", async () => {
    const { deps, writes, logs } = makeDeps({ readError: new Error("EACCES") });
    await persistProjectAllow("llm-tool-approval", "bash", deps);
    expect(writes[0]?.value.allow).toEqual(["bash"]);
    expect(logs.some((l) => l.includes("EACCES"))).toBe(true);
  });

  it("does not crash when cfgSvc.list returns no entry for this plugin", async () => {
    const writes: Array<unknown> = [];
    const deps: PersistDeps = {
      cfgSvc: {
        list: () => [],
        set: async (plugin, value, scope) => { writes.push({ plugin, value, scope }); },
      },
      log: () => {},
    };
    await persistProjectAllow("llm-tool-approval", "bash", deps);
    expect(writes).toEqual([
      { plugin: "llm-tool-approval", value: { allow: ["bash"] }, scope: "project" },
    ]);
  });
});
