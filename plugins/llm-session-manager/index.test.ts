// Top-level smoke test. Detailed lifecycle coverage lives in test/index.test.ts.
// This file exists so `kaizen plugin validate` finds a *.test.ts at the plugin
// root; remove or fold in if the validator stops requiring it.
import { describe, expect, test } from "bun:test";
import plugin from "./index";

describe("llm-session-manager manifest", () => {
  test("declares scoped permissions and provides sessions:store", () => {
    expect(plugin.name).toBe("llm-session-manager");
    expect(plugin.permissions?.tier).toBe("scoped");
    expect(plugin.services?.provides).toContain("sessions:store");
    expect(plugin.services?.consumes).toContain("llm-events:vocabulary");
  });
});
