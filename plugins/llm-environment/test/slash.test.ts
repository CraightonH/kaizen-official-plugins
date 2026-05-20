import { describe, expect, it } from "bun:test";
import { makeEnvSlashHandlers } from "../slash.ts";

function makeFakeSlashCtx() {
  const printed: string[] = [];
  return {
    ctx: {
      print: (s: string) => { printed.push(s); },
    },
    printed,
  };
}

describe("makeEnvSlashHandlers", () => {
  it("invokes refresh and prints confirmation", async () => {
    let calls = 0;
    const { refresh } = makeEnvSlashHandlers({
      refresh: async () => { calls += 1; },
    });
    const fake = makeFakeSlashCtx();
    await refresh.handler({ args: "", argv: [] }, fake.ctx as never);
    expect(calls).toBe(1);
    expect(fake.printed).toEqual(["environment refreshed"]);
  });

  it("exposes the slash manifest", () => {
    const { refresh } = makeEnvSlashHandlers({ refresh: async () => {} });
    expect(refresh.name).toBe("env:refresh");
    expect(refresh.description).toMatch(/refresh/i);
  });
});
