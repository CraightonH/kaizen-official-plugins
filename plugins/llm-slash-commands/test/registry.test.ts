import { describe, it, expect, mock } from "bun:test";
import { createRegistry, type SlashCommandManifest } from "../registry.ts";
import {
  BareNamePluginError,
  DuplicateRegistrationError,
  InvalidNameError,
} from "../errors.ts";

const noopHandler = async () => {};

function builtin(name: string, description = "d"): SlashCommandManifest {
  return { name, description, source: "builtin" };
}
function pluginM(name: string, description = "d"): SlashCommandManifest {
  return { name, description, source: "plugin" };
}
function fileM(name: string, filePath: string, description = "d"): SlashCommandManifest {
  return { name, description, source: "file", filePath };
}

describe("createRegistry", () => {
  it("register + get round-trips manifest and handler", () => {
    const reg = createRegistry();
    const handler = mock(async () => {});
    reg.register(builtin("help"), handler);
    const got = reg.get("help");
    expect(got?.manifest.name).toBe("help");
    expect(got?.handler).toBe(handler);
  });

  it("duplicate register throws DuplicateRegistrationError", () => {
    const reg = createRegistry();
    reg.register(builtin("help"), noopHandler);
    expect(() => reg.register(builtin("help"), noopHandler)).toThrow(DuplicateRegistrationError);
  });

  it("returned unregister removes the entry", () => {
    const reg = createRegistry();
    const off = reg.register(builtin("foo"), noopHandler);
    expect(reg.get("foo")).toBeDefined();
    off();
    expect(reg.get("foo")).toBeUndefined();
  });

  it("list returns sorted manifests", () => {
    const reg = createRegistry();
    reg.register(builtin("zebra"), noopHandler);
    reg.register(builtin("apple"), noopHandler);
    reg.register(pluginM("mcp:reload"), noopHandler);
    expect(reg.list().map(m => m.name)).toEqual(["apple", "mcp:reload", "zebra"]);
  });

  describe("bare-name enforcement", () => {
    it("source=plugin + bare name throws BareNamePluginError", () => {
      const reg = createRegistry();
      expect(() => reg.register(pluginM("foo"), noopHandler)).toThrow(BareNamePluginError);
    });

    it("source=plugin + namespaced name (foo:bar) succeeds", () => {
      const reg = createRegistry();
      reg.register(pluginM("foo:bar"), noopHandler);
      expect(reg.get("foo:bar")).toBeDefined();
    });

    it("source=plugin + triple namespaced (mcp:server:prompt) succeeds", () => {
      const reg = createRegistry();
      reg.register(pluginM("mcp:my-server:my-prompt"), noopHandler);
      expect(reg.get("mcp:my-server:my-prompt")).toBeDefined();
    });

    it("source=builtin + bare name succeeds (built-ins exempt)", () => {
      const reg = createRegistry();
      reg.register(builtin("help"), noopHandler);
      expect(reg.get("help")).toBeDefined();
    });

    it("source=file + bare name succeeds (file commands exempt)", () => {
      const reg = createRegistry();
      reg.register(fileM("echo", "/p/echo.md"), noopHandler);
      expect(reg.get("echo")).toBeDefined();
    });
  });

  describe("name shape validation", () => {
    it("rejects uppercase", () => {
      const reg = createRegistry();
      expect(() => reg.register(builtin("Help"), noopHandler)).toThrow(InvalidNameError);
    });
    it("rejects starting digit", () => {
      const reg = createRegistry();
      expect(() => reg.register(builtin("1help"), noopHandler)).toThrow(InvalidNameError);
    });
    it("rejects empty segment in namespaced name", () => {
      const reg = createRegistry();
      expect(() => reg.register(pluginM("mcp::reload"), noopHandler)).toThrow(InvalidNameError);
    });
    it("rejects underscore", () => {
      const reg = createRegistry();
      expect(() => reg.register(builtin("foo_bar"), noopHandler)).toThrow(InvalidNameError);
    });
    it("accepts dashed segment", () => {
      const reg = createRegistry();
      reg.register(builtin("skills-reload"), noopHandler);
      expect(reg.get("skills-reload")).toBeDefined();
    });
  });
});
