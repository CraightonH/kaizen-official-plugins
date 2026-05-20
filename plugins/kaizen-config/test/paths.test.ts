import { describe, it, expect } from "bun:test";
import { harnessKey, homeConfigPath, projectConfigPath, type HarnessIdentity } from "../paths.ts";

describe("harnessKey", () => {
  it("uses ref when present, stripping version", () => {
    expect(harnessKey({ ref: "official/openai-compatible@0.1.0" })).toBe("official_openai-compatible");
  });
  it("derives from jsonPath basename when ref missing", () => {
    expect(harnessKey({ jsonPath: "/abs/harnesses/openai-compatible.json" })).toBe("local_openai-compatible");
  });
  it("derives from parent dir when jsonPath is kaizen.json", () => {
    expect(harnessKey({ jsonPath: "/abs/my-harness/kaizen.json" })).toBe("local_my-harness");
  });
  it("returns 'default' when identity is empty", () => {
    expect(harnessKey({})).toBe("default");
  });
  it("sanitizes unsafe chars", () => {
    expect(harnessKey({ jsonPath: "/x/weird name?.json" })).toBe("local_weird_name_");
  });
  it("throws when ref derives to a reserved 'local'-prefixed key", () => {
    expect(() => harnessKey({ ref: "local/something@0.1.0" })).toThrow(/reserved local session key/);
  });
});

describe("path resolution", () => {
  it("homeConfigPath joins home + harnesses + key + config.json", () => {
    expect(homeConfigPath("/u/me", "official_openai-compatible"))
      .toBe("/u/me/.kaizen/harnesses/official_openai-compatible/config.json");
  });
  it("projectConfigPath joins cwd + .kaizen + harnesses + key + config.json", () => {
    expect(projectConfigPath("/proj", "default"))
      .toBe("/proj/.kaizen/harnesses/default/config.json");
  });
});
