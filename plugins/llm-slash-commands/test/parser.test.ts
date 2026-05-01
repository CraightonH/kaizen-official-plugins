import { describe, it, expect } from "bun:test";
import { parse } from "../parser.ts";

describe("parse", () => {
  it("parses bare command", () => {
    expect(parse("/help")).toEqual({ name: "help", args: "" });
  });

  it("parses command with single-word args", () => {
    expect(parse("/help model")).toEqual({ name: "help", args: "model" });
  });

  it("preserves interior whitespace and trailing space", () => {
    expect(parse("/note   hello   world  ")).toEqual({ name: "note", args: "  hello   world  " });
  });

  it("parses dashed name", () => {
    expect(parse("/skills-reload foo")).toEqual({ name: "skills-reload", args: "foo" });
  });

  it("parses namespaced (colon) name", () => {
    // The parser does not enforce the colon rule — that's the registry's job.
    // But the colon must be a legal char in name. Spec says `[a-z0-9-]+` per segment;
    // for parser purposes we accept colons too so namespaced commands dispatch.
    expect(parse("/mcp:reload args")).toEqual({ name: "mcp:reload", args: "args" });
  });

  it("rejects empty input", () => {
    expect(parse("")).toBeNull();
  });

  it("rejects no leading slash", () => {
    expect(parse("hello /foo")).toBeNull();
  });

  it("rejects double slash", () => {
    expect(parse("//path")).toBeNull();
  });

  it("rejects /. (path-like)", () => {
    expect(parse("/.git")).toBeNull();
  });

  it("rejects uppercase first char (case-sensitive)", () => {
    expect(parse("/Foo")).toBeNull();
  });

  it("rejects /<digit>", () => {
    expect(parse("/1foo")).toBeNull();
  });

  it("treats raw JSON arg as opaque string", () => {
    expect(parse(`/run {"x":1}`)).toEqual({ name: "run", args: `{"x":1}` });
  });

  it("rejects /<name><non-space>", () => {
    // a character outside [a-z0-9-:] terminating the name without a space → reject
    expect(parse("/foo!bar")).toBeNull();
  });
});
