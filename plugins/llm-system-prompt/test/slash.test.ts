import { describe, expect, it, mock } from "bun:test";
import { createRegistry } from "../registry.ts";
import { makePromptSlashHandlers } from "../slash.ts";

function makeCtx(args = "") {
  const printed: string[] = [];
  return {
    args,
    raw: `/prompt:show ${args}`.trim(),
    signal: new AbortController().signal,
    emit: mock(async () => {}),
    print: mock(async (t: string) => { printed.push(t); }),
    printed,
  };
}

describe("slash /prompt:show", () => {
  it("prints assembled prompt with section headers when no args", async () => {
    const reg = createRegistry({ emit: mock(() => Promise.resolve()) });
    reg.register({ id: "identity", priority: 10, render: () => "I AM" });
    reg.register({ id: "x:y", priority: 100, render: () => "BODY", title: "TitleY" });

    const handlers = makePromptSlashHandlers({
      registry: reg,
      reloadIdentity: async () => {},
    });

    const ctx = makeCtx("");
    await handlers.show(ctx);
    const out = ctx.printed.join("\n");
    expect(out).toContain("[identity, p=10]");
    expect(out).toContain("I AM");
    expect(out).toContain("[x:y, p=100, title=TitleY]");
    expect(out).toContain("BODY");
  });

  it("--stats appends per-section length and rebuild count", async () => {
    const reg = createRegistry({ emit: mock(() => Promise.resolve()) });
    reg.register({ id: "a", priority: 100, render: () => "AAAAA" });

    const handlers = makePromptSlashHandlers({
      registry: reg,
      reloadIdentity: async () => {},
    });

    const ctx = makeCtx("--stats");
    await handlers.show(ctx);
    const out = ctx.printed.join("\n");
    expect(out).toMatch(/a:\s*\d+ chars/);
    expect(out).toMatch(/generation: \d+/);
  });
});

describe("slash /prompt:reload", () => {
  it("calls the reload callback and prints confirmation", async () => {
    const reg = createRegistry({ emit: mock(() => Promise.resolve()) });
    const reload = mock(async () => {});

    const handlers = makePromptSlashHandlers({
      registry: reg,
      reloadIdentity: reload,
    });

    const ctx = makeCtx("");
    await handlers.reload(ctx);
    expect(reload).toHaveBeenCalled();
    expect(ctx.printed.join("\n")).toMatch(/reloaded/i);
  });
});

describe("slash /prompt:disable + /prompt:enable", () => {
  it("disable hides the section's body from /prompt:show", async () => {
    const reg = createRegistry({ emit: mock(() => Promise.resolve()) });
    reg.register({ id: "a", priority: 100, render: () => "SHOULD-NOT-APPEAR" });

    const handlers = makePromptSlashHandlers({
      registry: reg,
      reloadIdentity: async () => {},
    });

    await handlers.disable(makeCtx("a"));
    const ctx = makeCtx("");
    await handlers.show(ctx);
    expect(ctx.printed.join("\n")).not.toContain("SHOULD-NOT-APPEAR");
  });

  it("enable restores the section", async () => {
    const reg = createRegistry({ emit: mock(() => Promise.resolve()) });
    reg.register({ id: "a", priority: 100, render: () => "RESTORED" });

    const handlers = makePromptSlashHandlers({
      registry: reg,
      reloadIdentity: async () => {},
    });

    await handlers.disable(makeCtx("a"));
    await handlers.enable(makeCtx("a"));
    const ctx = makeCtx("");
    await handlers.show(ctx);
    expect(ctx.printed.join("\n")).toContain("RESTORED");
  });

  it("disable with unknown id prints a friendly error", async () => {
    const reg = createRegistry({ emit: mock(() => Promise.resolve()) });

    const handlers = makePromptSlashHandlers({
      registry: reg,
      reloadIdentity: async () => {},
    });

    const ctx = makeCtx("nope");
    await handlers.disable(ctx);
    expect(ctx.printed.join("\n")).toMatch(/no section/i);
  });
});
