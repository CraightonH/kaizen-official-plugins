import { expect, it } from "bun:test";
import plugin from "./index.ts";

it("exports a plugin with the expected manifest", () => {
  expect(plugin.name).toBe("llm-environment");
  expect(plugin.apiVersion).toBe("3.0.0");
  expect(typeof plugin.setup).toBe("function");
  expect(typeof plugin.stop).toBe("function");
});
