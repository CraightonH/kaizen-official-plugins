import { describe, expect, it } from "bun:test";
import plugin from "./index.ts";
import type {
  DriverService,
  RunConversationInput,
  RunConversationOutput,
} from "./public";

describe("llm-driver manifest smoke", () => {
  it("declares the required plugin metadata", () => {
    expect(plugin.name).toBe("llm-driver");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.driver).toBe(true);
    expect(plugin.permissions?.tier).toBe("unscoped");
    expect(plugin.services?.provides).toContain("driver:run-conversation");
  });

  it("owns the driver:run-conversation public contract", () => {
    type _Driver = DriverService extends {
      runConversation: (...a: any[]) => Promise<any>;
    } ? true : false;
    const driverOk: _Driver = true;
    expect(driverOk).toBe(true);

    const seededTailInput: RunConversationInput = {
      systemPrompt: "",
      sessionId: "session-1",
    };
    expect(seededTailInput.sessionId).toBe("session-1");

    type _Out = RunConversationOutput extends {
      finalMessage: any;
      usage: { promptTokens: number; completionTokens: number };
    } ? true : false;
    const outputOk: _Out = true;
    expect(outputOk).toBe(true);
  });
});
