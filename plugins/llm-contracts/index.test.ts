import { describe, expect, it } from "bun:test";
import plugin from "./index.ts";

describe("llm-contracts defineService", () => {
  it("calls defineService for every declared contract", async () => {
    const defined: string[] = [];
    const ctx = {
      defineService: (id: string) => { defined.push(id); },
    };

    await plugin.setup(ctx as any);

    const expected = [
      "config:store",
      "events:vocabulary",
      "llm:complete",
      "sessions:store",
      "tools:registry",
      "prompt:registry",
      "slash:registry",
      "skills:registry",
      "memory:store",
      "agents:registry",
      "mcp:bridge",
      "dispatch:strategy",
      "ui:channel",
      "ui:theme",
      "ui:status",
      "ui:completion-source",
      "ui:tool-renderer",
      "ui:prompt",
      "driver:run-conversation",
      "axioms:registry",
      "secrets:registry",
    ];

    for (const id of expected) {
      expect(defined).toContain(id);
    }
    expect(defined).toHaveLength(expected.length);
  });
});
