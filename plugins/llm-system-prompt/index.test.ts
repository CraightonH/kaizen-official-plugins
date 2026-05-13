import { expect, it } from "bun:test";
import { tmpdir } from "node:os";
import plugin from "./index.ts";

it("setup provides prompt:registry", async () => {
  const provided: Record<string, unknown> = {};
  const ctx = {
    cwd: tmpdir(),
    env: {},
    config: {},
    log: (_m: string) => {},
    defineService: (_n: string, _o: unknown) => {},
    provideService: <T,>(n: string, v: T) => { provided[n] = v; },
    consumeService: (_n: string) => {},
    useService: (n: string) => {
      if (n === "events:vocabulary") {
        return {
          PROMPT_REBUILT: "prompt:rebuilt",
          PROMPT_RELOAD: "prompt:reload",
        };
      }
      throw new Error(`missing service ${n}`);
    },
    defineEvent: (_n: string) => {},
    emit: async () => [],
    on: (_n: string, _h: unknown) => {},
  };

  await plugin.setup(ctx as any);
  expect(provided["prompt:registry"]).toBeTruthy();
});
