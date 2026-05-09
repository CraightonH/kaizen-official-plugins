import { describe, it, expect, mock } from "bun:test";
import { registerSlashCommands, type SlashRegistryLike } from "../slash.ts";
import type { CommandsApi } from "../commands.ts";

interface RegisteredCommand {
  manifest: { name: string; description: string; usage?: string };
  handler: (ctx: { args: string; print: (t: string) => Promise<void> }) => Promise<void>;
}

function fakeSlash(): { svc: SlashRegistryLike; commands: RegisteredCommand[] } {
  const commands: RegisteredCommand[] = [];
  return {
    commands,
    svc: { register: (manifest, handler) => { commands.push({ manifest, handler }); return () => {}; } },
  };
}

function fakeCommands(overrides: Partial<CommandsApi> = {}): CommandsApi {
  return {
    clearSession: mock(async () => ({ from: null, to: "new", alias: null })),
    listSessions: mock(async () => []),
    resumeSession: mock(async (opts) => ({ id: opts.id_or_alias, alias: null })),
    renameActiveSession: mock(async (opts) => ({ id: "active", alias: opts.name })),
    deleteSession: mock(async (opts) => ({ deleted: opts.id })),
    ...overrides,
  };
}

function captureCtx() {
  const out: string[] = [];
  return { out, make: (args: string) => ({ args, print: async (t: string) => { out.push(t); } }) };
}

describe("session slash commands", () => {
  it("registers exactly /clear, /session:new, /session:list, /session:resume, /session:rename, /session:delete", () => {
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, fakeCommands());
    expect(commands.map((c) => c.manifest.name).sort()).toEqual([
      "clear",
      "session:delete",
      "session:list",
      "session:new",
      "session:rename",
      "session:resume",
    ]);
  });

  it("/clear and /session:new both call clearSession and print active session id", async () => {
    const cmds = fakeCommands({
      clearSession: mock(async () => ({ from: "old", to: "new-id", alias: "owl" })),
    });
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, cmds);
    const cap = captureCtx();
    for (const name of ["clear", "session:new"]) {
      cap.out.length = 0;
      await commands.find((c) => c.manifest.name === name)!.handler(cap.make(""));
      expect(cap.out[0]).toBe("Active session: new-id");
    }
    expect((cmds.clearSession as any).mock.calls.length).toBe(2);
  });

  it("/session:new with no args: bare archive+switch (backward-compat)", async () => {
    let captured: any = "no-call";
    const cmds: any = { clearSession: async (o: any) => { captured = o; return { from: null, to: "x", alias: null, seeded: false }; } };
    const handlers: Record<string, any> = {};
    const slash = { register: (m: any, h: any) => { handlers[m.name] = h; return () => {}; } };
    registerSlashCommands(slash as any, cmds);
    await handlers["session:new"]({ args: "", print: async () => {} });
    expect(captured).toEqual({});
  });

  it("/session:new <text>: prompt + autostart=true", async () => {
    let captured: any = null;
    const cmds: any = { clearSession: async (o: any) => { captured = o; return { from: null, to: "x", alias: null, seeded: true }; } };
    const handlers: Record<string, any> = {};
    const slash = { register: (m: any, h: any) => { handlers[m.name] = h; return () => {}; } };
    registerSlashCommands(slash as any, cmds);
    await handlers["session:new"]({ args: "continue the refactor", print: async () => {} });
    expect(captured).toEqual({ prompt: "continue the refactor", autostart: true });
  });

  it("/session:new --draft <text>: prompt + autostart=false", async () => {
    let captured: any = null;
    const cmds: any = { clearSession: async (o: any) => { captured = o; return { from: null, to: "x", alias: null, seeded: true }; } };
    const handlers: Record<string, any> = {};
    const slash = { register: (m: any, h: any) => { handlers[m.name] = h; return () => {}; } };
    registerSlashCommands(slash as any, cmds);
    await handlers["session:new"]({ args: "--draft continue the refactor", print: async () => {} });
    expect(captured).toEqual({ prompt: "continue the refactor", autostart: false });
  });

  it("/session:list passes --all → includeChildren: true", async () => {
    const list = mock(async () => [
      { id: "s1", alias: "owl", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] },
    ]);
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, fakeCommands({ listSessions: list as any }));
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "session:list")!.handler(cap.make("--all"));
    expect((list as any).mock.calls[0][0]).toEqual({ includeChildren: true });
    expect(cap.out[0]).toContain("s1");
    expect(cap.out[0]).toContain("(owl)");
  });

  it("/session:list prints 'No sessions.' when empty", async () => {
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, fakeCommands({ listSessions: mock(async () => []) as any }));
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "session:list")!.handler(cap.make(""));
    expect(cap.out[0]).toBe("No sessions.");
  });

  it("/session:resume passes the trimmed arg to resumeSession", async () => {
    const resume = mock(async () => ({ id: "s2", alias: null }));
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, fakeCommands({ resumeSession: resume as any }));
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "session:resume")!.handler(cap.make("  fox "));
    expect((resume as any).mock.calls[0][0]).toEqual({ id_or_alias: "fox" });
    expect(cap.out[0]).toBe("Active session: s2");
  });

  it("/session:rename prints success and surfaces errors via print", async () => {
    const rename = mock(async () => { throw new Error("alias taken"); });
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, fakeCommands({ renameActiveSession: rename as any }));
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "session:rename")!.handler(cap.make("dup"));
    expect(cap.out[0]).toBe("Rename failed: alias taken");
  });

  it("/session:rename prints usage when arg missing", async () => {
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, fakeCommands());
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "session:rename")!.handler(cap.make(""));
    expect(cap.out[0]).toBe("Usage: /session:rename <new-name>");
  });

  it("/session:delete with --cascade", async () => {
    const del = mock(async (opts: any) => ({ deleted: opts.id }));
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, fakeCommands({ deleteSession: del as any }));
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "session:delete")!.handler(cap.make("foo --cascade"));
    expect((del as any).mock.calls[0][0]).toEqual({ id: "foo", cascade: true });
    expect(cap.out[0]).toBe("Deleted session: foo");
  });

  it("/session:delete prints replacement note when active session", async () => {
    const del = mock(async () => ({ deleted: "active", replacement: "new" }));
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, fakeCommands({ deleteSession: del as any }));
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "session:delete")!.handler(cap.make("active"));
    expect(cap.out[0]).toBe("Active session: new");
  });
});
