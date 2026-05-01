import { describe, it, expect, mock } from "bun:test";
import { runHook, type RunnerDeps } from "../runner.ts";
import type { HookEntry } from "../config.ts";

function makeDeps(execImpl: RunnerDeps["exec"]): { deps: RunnerDeps; logs: { level: "info" | "warn"; msg: string }[] } {
  const logs: { level: "info" | "warn"; msg: string }[] = [];
  return {
    logs,
    deps: {
      exec: execImpl,
      log: (level, msg) => logs.push({ level, msg }),
    },
  };
}

const baseEntry: HookEntry = { event: "turn:start", command: "true" };

describe("runHook", () => {
  it("exit 0 + non-empty stdout → ok, info log per line", async () => {
    const { deps, logs } = makeDeps(async () => ({ exitCode: 0, stdout: "hello\nworld\n", stderr: "" }));
    const r = await runHook(baseEntry, { EVENT_NAME: "turn:start" }, deps);
    expect(r.ok).toBe(true);
    expect(r.stderr).toBe("");
    expect(logs.filter(l => l.level === "info")).toHaveLength(2);
    expect(logs[0]!.msg).toContain("[hook event=turn:start]");
    expect(logs[0]!.msg).toContain("hello");
  });

  it("exit 0 + empty stdout → ok, no info log", async () => {
    const { deps, logs } = makeDeps(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const r = await runHook(baseEntry, {}, deps);
    expect(r.ok).toBe(true);
    expect(logs).toEqual([]);
  });

  it("non-zero exit → not ok, warn log carrying stderr", async () => {
    const { deps, logs } = makeDeps(async () => ({ exitCode: 1, stdout: "", stderr: "boom\n" }));
    const r = await runHook(baseEntry, {}, deps);
    expect(r.ok).toBe(false);
    expect(r.stderr).toBe("boom\n");
    expect(logs.find(l => l.level === "warn")?.msg).toContain("boom");
  });

  it("timeout → not ok, treated like non-zero, warn log mentions timeout", async () => {
    const { deps, logs } = makeDeps(async () => { throw Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" }); });
    const r = await runHook({ ...baseEntry, timeout_ms: 100 }, {}, deps);
    expect(r.ok).toBe(false);
    expect(logs.find(l => l.level === "warn")?.msg).toMatch(/timeout/i);
  });

  it("spawn failure → not ok, warn log carrying error", async () => {
    const { deps, logs } = makeDeps(async () => { throw new Error("ENOENT sh"); });
    const r = await runHook(baseEntry, {}, deps);
    expect(r.ok).toBe(false);
    expect(logs.find(l => l.level === "warn")?.msg).toMatch(/ENOENT sh/);
  });

  it("invokes sh -c with the entry command and merged env", async () => {
    let captured: any = null;
    const { deps } = makeDeps(async (bin, args, opts) => {
      captured = { bin, args, opts };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await runHook({ ...baseEntry, env: { EXTRA: "yes" } }, { EVENT_NAME: "turn:start" }, deps);
    expect(captured.bin).toBe("sh");
    expect(captured.args).toEqual(["-c", "true"]);
    expect(captured.opts.env).toMatchObject({ EVENT_NAME: "turn:start", EXTRA: "yes" });
  });

  it("default timeout is 30_000 ms; entry override wins", async () => {
    let captured: any = null;
    const { deps } = makeDeps(async (_b, _a, opts) => {
      captured = opts;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await runHook(baseEntry, {}, deps);
    expect(captured.timeoutMs).toBe(30_000);
    await runHook({ ...baseEntry, timeout_ms: 1234 }, {}, deps);
    expect(captured.timeoutMs).toBe(1234);
  });
});
