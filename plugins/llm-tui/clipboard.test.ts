import { describe, expect, test } from "bun:test";
import { copyToClipboard, type ClipboardDeps } from "./clipboard.ts";

// Helper: build a deps bag with controllable spawn + stdout sink + platform.
function mkDeps(opts: {
  platform: NodeJS.Platform;
  spawn?: (cmd: string[], stdin: string) => Promise<{ exitCode: number; missing?: boolean }>;
  stdoutSink?: { writes: string[] };
}): ClipboardDeps {
  const writes = opts.stdoutSink?.writes ?? [];
  return {
    platform: opts.platform,
    spawn: opts.spawn ?? (async () => ({ exitCode: 0 })),
    writeStdout: (s) => { writes.push(s); },
  };
}

describe("copyToClipboard", () => {
  test("darwin uses pbcopy", async () => {
    const calls: string[][] = [];
    const deps = mkDeps({
      platform: "darwin",
      spawn: async (cmd) => { calls.push(cmd); return { exitCode: 0 }; },
    });
    const r = await copyToClipboard("hello", deps);
    expect(r.ok).toBe(true);
    expect(r.via).toBe("pbcopy");
    expect(calls[0]?.[0]).toBe("pbcopy");
  });

  test("linux uses xclip first", async () => {
    const calls: string[][] = [];
    const deps = mkDeps({
      platform: "linux",
      spawn: async (cmd) => { calls.push(cmd); return { exitCode: 0 }; },
    });
    const r = await copyToClipboard("hello", deps);
    expect(r.ok).toBe(true);
    expect(r.via).toBe("xclip");
    expect(calls[0]?.[0]).toBe("xclip");
  });

  test("linux falls back to xsel when xclip missing", async () => {
    const calls: string[][] = [];
    const deps = mkDeps({
      platform: "linux",
      spawn: async (cmd) => {
        calls.push(cmd);
        if (cmd[0] === "xclip") return { exitCode: 1, missing: true };
        return { exitCode: 0 };
      },
    });
    const r = await copyToClipboard("hello", deps);
    expect(r.ok).toBe(true);
    expect(r.via).toBe("xsel");
    expect(calls.map((c) => c[0])).toEqual(["xclip", "xsel"]);
  });

  test("win32 uses clip.exe", async () => {
    const deps = mkDeps({
      platform: "win32",
      spawn: async () => ({ exitCode: 0 }),
    });
    const r = await copyToClipboard("hello", deps);
    expect(r.ok).toBe(true);
    expect(r.via).toBe("clip");
  });

  test("falls back to OSC 52 when all subprocesses fail", async () => {
    const sink = { writes: [] as string[] };
    const deps = mkDeps({
      platform: "linux",
      spawn: async () => ({ exitCode: 1, missing: true }),
      stdoutSink: sink,
    });
    const r = await copyToClipboard("hello", deps);
    expect(r.ok).toBe(true);
    expect(r.via).toBe("osc52");
    // OSC 52 sequence: ESC ] 52 ; c ; <base64> BEL
    expect(sink.writes[0]).toMatch(/\x1B\]52;c;/);
    expect(sink.writes[0]).toContain(Buffer.from("hello").toString("base64"));
    expect(sink.writes[0]).toMatch(/\x07$/);
  });

  test("returns ok:false when subprocess errors and OSC 52 throws", async () => {
    const deps: ClipboardDeps = {
      platform: "darwin",
      spawn: async () => ({ exitCode: 1, missing: true }),
      writeStdout: () => { throw new Error("no stdout"); },
    };
    const r = await copyToClipboard("hello", deps);
    expect(r.ok).toBe(false);
    expect(r.via).toBe("none");
    expect(r.error).toBeDefined();
  });
});
