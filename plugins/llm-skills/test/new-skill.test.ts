import { describe, it, expect } from "bun:test";
import { NEW_SKILL_SCHEMA, validateNewSkillInput } from "../new-skill.ts";

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

describe("validateNewSkillInput", () => {
  const good = { name: "git-rebase", description: "How to rebase cleanly.", body: "Step 1.", scope: "user" as const };

  it("accepts a valid input", () => {
    expect(() => validateNewSkillInput(good)).not.toThrow();
  });

  it("rejects non-object args", () => {
    expect(() => validateNewSkillInput(null)).toThrow(/args must be an object/i);
    expect(() => validateNewSkillInput("foo")).toThrow(/args must be an object/i);
    expect(() => validateNewSkillInput(7 as any)).toThrow(/args must be an object/i);
  });

  it("rejects missing or non-string name", () => {
    expect(() => validateNewSkillInput({ ...good, name: undefined } as any)).toThrow(/name/i);
    expect(() => validateNewSkillInput({ ...good, name: 7 } as any)).toThrow(/name/i);
  });

  it("rejects bad name shape", () => {
    expect(() => validateNewSkillInput({ ...good, name: "Foo" })).toThrow(/name must match/i);
    expect(() => validateNewSkillInput({ ...good, name: "-foo" })).toThrow(/name must match/i);
    expect(() => validateNewSkillInput({ ...good, name: "foo/bar" })).toThrow(/name must match/i);
    expect(() => validateNewSkillInput({ ...good, name: ".." })).toThrow(/name must match/i);
    expect(() => validateNewSkillInput({ ...good, name: "foo.bar" })).toThrow(/name must match/i);
    expect(() => validateNewSkillInput({ ...good, name: " foo" })).toThrow(/name must match/i);
  });

  it("rejects name > 64 chars", () => {
    expect(() => validateNewSkillInput({ ...good, name: "a".repeat(65) })).toThrow(/name must be ≤ 64/);
  });

  it("accepts name exactly 64 chars", () => {
    expect(() => validateNewSkillInput({ ...good, name: "a".repeat(64) })).not.toThrow();
  });

  it("rejects missing or non-string description", () => {
    expect(() => validateNewSkillInput({ ...good, description: undefined } as any)).toThrow(/description/i);
    expect(() => validateNewSkillInput({ ...good, description: 7 } as any)).toThrow(/description/i);
  });

  it("rejects empty/whitespace description", () => {
    expect(() => validateNewSkillInput({ ...good, description: "" })).toThrow(/description must be non-empty/i);
    expect(() => validateNewSkillInput({ ...good, description: "   " })).toThrow(/description must be non-empty/i);
  });

  it("rejects multi-line description", () => {
    expect(() => validateNewSkillInput({ ...good, description: "line1\nline2" })).toThrow(/single-line/i);
    expect(() => validateNewSkillInput({ ...good, description: "line1\rline2" })).toThrow(/single-line/i);
  });

  it("rejects description > 200 chars", () => {
    expect(() => validateNewSkillInput({ ...good, description: "a".repeat(201) })).toThrow(/≤ 200/);
  });

  it("accepts description exactly 200 chars", () => {
    expect(() => validateNewSkillInput({ ...good, description: "a".repeat(200) })).not.toThrow();
  });

  it("rejects missing or non-string body", () => {
    expect(() => validateNewSkillInput({ ...good, body: undefined } as any)).toThrow(/body/i);
    expect(() => validateNewSkillInput({ ...good, body: 7 } as any)).toThrow(/body/i);
  });

  it("rejects whitespace-only body", () => {
    expect(() => validateNewSkillInput({ ...good, body: "" })).toThrow(/body must be non-empty/i);
    expect(() => validateNewSkillInput({ ...good, body: "   \n  " })).toThrow(/body must be non-empty/i);
  });

  it("rejects bad scope", () => {
    expect(() => validateNewSkillInput({ ...good, scope: "global" } as any)).toThrow(/scope/i);
    expect(() => validateNewSkillInput({ ...good, scope: undefined } as any)).toThrow(/scope/i);
  });
});
