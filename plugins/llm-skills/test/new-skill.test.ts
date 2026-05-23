import { describe, it, expect } from "bun:test";
import { NEW_SKILL_SCHEMA } from "../new-skill.ts";

describe("NEW_SKILL_SCHEMA", () => {
  it("declares the contract for the new_skill tool", () => {
    expect(NEW_SKILL_SCHEMA.name).toBe("new_skill");
    expect(NEW_SKILL_SCHEMA.description).toMatch(/skill/i);
    expect(NEW_SKILL_SCHEMA.parameters.type).toBe("object");
    expect(NEW_SKILL_SCHEMA.parameters.additionalProperties).toBe(false);
    expect(NEW_SKILL_SCHEMA.parameters.required?.sort()).toEqual(["body", "description", "name", "scope"]);
  });

  it("scope is a string enum of 'project' | 'user'", () => {
    const scope = NEW_SKILL_SCHEMA.parameters.properties?.scope as any;
    expect(scope).toBeDefined();
    expect(scope.type).toBe("string");
    expect(scope.enum?.sort()).toEqual(["project", "user"]);
  });

  it("is tagged skills/synthetic/mutating", () => {
    expect(NEW_SKILL_SCHEMA.tags?.sort()).toEqual(["mutating", "skills", "synthetic"]);
  });
});
