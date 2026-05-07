import { test, expect } from "bun:test";
import { makeToolRendererRegistry } from "./registry.ts";

test("register and lookup return the registered renderer", () => {
  const reg = makeToolRendererRegistry();
  const renderer = {
    toolName: "read_file",
    collapsedSummary: () => "summary",
    expandedView: () => null as any,
  };
  const off = reg.service.register(renderer);
  expect(reg.lookup("read_file")).toBe(renderer);
  off();
  expect(reg.lookup("read_file")).toBeUndefined();
});

test("unknown tool returns undefined", () => {
  const reg = makeToolRendererRegistry();
  expect(reg.lookup("nope")).toBeUndefined();
});

test("re-register replaces the prior renderer", () => {
  const reg = makeToolRendererRegistry();
  const r1 = { toolName: "x", collapsedSummary: () => "1", expandedView: () => null as any };
  const r2 = { toolName: "x", collapsedSummary: () => "2", expandedView: () => null as any };
  reg.service.register(r1);
  reg.service.register(r2);
  expect(reg.lookup("x")).toBe(r2);
});
