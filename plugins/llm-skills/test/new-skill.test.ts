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

import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { readFile, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTargetPath, assertNoCollision } from "../new-skill.ts";
import { makeNewSkillHandler, composeSkillFile } from "../new-skill.ts";
import type { SkillsRegistryService } from "../public";

describe("resolveTargetPath", () => {
  it("returns <projectRoot>/<name>/SKILL.md for scope=project", () => {
    const out = resolveTargetPath({ name: "foo", scope: "project", projectRoot: "/p", userRoot: "/u" });
    expect(out).toEqual({ baseDir: "/p/foo", file: "/p/foo/SKILL.md" });
  });

  it("returns <userRoot>/<name>/SKILL.md for scope=user", () => {
    const out = resolveTargetPath({ name: "foo", scope: "user", projectRoot: "/p", userRoot: "/u" });
    expect(out).toEqual({ baseDir: "/u/foo", file: "/u/foo/SKILL.md" });
  });
});

describe("assertNoCollision", () => {
  async function makeTmpRoot() {
    return mkdtemp(join(tmpdir(), "new-skill-"));
  }

  it("returns successfully when nothing exists at the target", async () => {
    const root = await makeTmpRoot();
    await expect(assertNoCollision(join(root, "foo"), "foo")).resolves.toBeUndefined();
    await rm(root, { recursive: true });
  });

  it("throws when a directory already exists at the target (even without SKILL.md)", async () => {
    const root = await makeTmpRoot();
    await mkdir(join(root, "foo"), { recursive: true });
    await expect(assertNoCollision(join(root, "foo"), "foo")).rejects.toThrow(/already exists/);
    await rm(root, { recursive: true });
  });

  it("throws when a file exists at the target", async () => {
    const root = await makeTmpRoot();
    await writeFile(join(root, "foo"), "");
    await expect(assertNoCollision(join(root, "foo"), "foo")).rejects.toThrow(/already exists/);
    await rm(root, { recursive: true });
  });

  it("throws when a symlink exists at the target (and does not follow it)", async () => {
    const root = await makeTmpRoot();
    await symlink("/tmp", join(root, "foo"));
    await expect(assertNoCollision(join(root, "foo"), "foo")).rejects.toThrow(/already exists/);
    await rm(root, { recursive: true });
  });
});

describe("composeSkillFile", () => {
  it("emits the canonical frontmatter + body shape", () => {
    const text = composeSkillFile({ name: "foo", description: "bar", body: "baz" });
    expect(text).toBe("---\nname: foo\ndescription: bar\n---\n\nbaz\n");
  });

  it("appends a trailing newline if the body does not already end with one", () => {
    const t1 = composeSkillFile({ name: "foo", description: "bar", body: "baz" });
    expect(t1.endsWith("\n")).toBe(true);
    const t2 = composeSkillFile({ name: "foo", description: "bar", body: "baz\n" });
    expect(t2.endsWith("baz\n")).toBe(true);
    expect(t2.endsWith("\n\n")).toBe(false);
  });
});

function fakeRegistry(opts: { listEntry?: { name: string; tokens?: number; baseDir?: string } } = {}): SkillsRegistryService & { rescanCalls: number } {
  let calls = 0;
  return {
    list: () => opts.listEntry ? [{ name: opts.listEntry.name, description: "d", tokens: opts.listEntry.tokens, baseDir: opts.listEntry.baseDir }] : [],
    load: async (n: string) => { throw new Error(`unknown skill: ${n}`); },
    register: () => () => {},
    rescan: async () => { calls++; return { changed: true, count: opts.listEntry ? 1 : 0 }; },
    get rescanCalls() { return calls; },
  } as any;
}

describe("makeNewSkillHandler", () => {
  async function makeRoots() {
    const projectRoot = await mkdtemp(join(tmpdir(), "ns-proj-"));
    const userRoot = await mkdtemp(join(tmpdir(), "ns-user-"));
    return { projectRoot, userRoot };
  }

  it("writes SKILL.md, rescans once, and returns { name, path, scope, tokens }", async () => {
    const { projectRoot, userRoot } = await makeRoots();
    const registry = fakeRegistry({ listEntry: { name: "git-rebase", tokens: 17, baseDir: join(projectRoot, "git-rebase") } });
    const handler = makeNewSkillHandler({ projectRoot, userRoot, registry });
    const result = await handler({
      name: "git-rebase",
      description: "How to rebase cleanly.",
      body: "Step 1.",
      scope: "project",
    }, { signal: new AbortController().signal, callId: "c1", log: () => {} });
    expect(result).toEqual({
      name: "git-rebase",
      path: join(projectRoot, "git-rebase", "SKILL.md"),
      scope: "project",
      tokens: 17,
    });
    expect(registry.rescanCalls).toBe(1);
    const written = await readFile(join(projectRoot, "git-rebase", "SKILL.md"), "utf8");
    expect(written).toBe("---\nname: git-rebase\ndescription: How to rebase cleanly.\n---\n\nStep 1.\n");
    await rm(projectRoot, { recursive: true });
    await rm(userRoot, { recursive: true });
  });

  it("writes under the user root when scope='user'", async () => {
    const { projectRoot, userRoot } = await makeRoots();
    const registry = fakeRegistry({ listEntry: { name: "foo", tokens: 5, baseDir: join(userRoot, "foo") } });
    const handler = makeNewSkillHandler({ projectRoot, userRoot, registry });
    const result = await handler({ name: "foo", description: "d", body: "b", scope: "user" }, { signal: new AbortController().signal, callId: "c", log: () => {} });
    expect((result as any).path).toBe(join(userRoot, "foo", "SKILL.md"));
    expect((result as any).scope).toBe("user");
    const exists = await fsStat(join(userRoot, "foo", "SKILL.md"));
    expect(exists.isFile()).toBe(true);
    await rm(projectRoot, { recursive: true });
    await rm(userRoot, { recursive: true });
  });

  it("creates the scope root if missing (mkdir -p)", async () => {
    const proj = await mkdtemp(join(tmpdir(), "ns-proj-"));
    const userRoot = join(proj, "nonexistent-user-root");   // does not exist yet
    const projectRoot = proj;
    const registry = fakeRegistry({ listEntry: { name: "x", tokens: 1, baseDir: join(userRoot, "x") } });
    const handler = makeNewSkillHandler({ projectRoot, userRoot, registry });
    await handler({ name: "x", description: "d", body: "b", scope: "user" }, { signal: new AbortController().signal, callId: "c", log: () => {} });
    const exists = await fsStat(join(userRoot, "x", "SKILL.md"));
    expect(exists.isFile()).toBe(true);
    await rm(proj, { recursive: true });
  });

  it("falls back to estimateTokens when rescan list does not surface tokens", async () => {
    const { projectRoot, userRoot } = await makeRoots();
    const registry: SkillsRegistryService = {
      list: () => [],   // empty even after rescan
      load: async () => { throw new Error("nope"); },
      register: () => () => {},
      rescan: async () => ({ changed: true, count: 0 }),
    } as any;
    const handler = makeNewSkillHandler({ projectRoot, userRoot, registry });
    const result = await handler({ name: "foo", description: "d", body: "abcd", scope: "user" }, { signal: new AbortController().signal, callId: "c", log: () => {} });
    // body 'abcd' → estimateTokens = ceil(4/4) = 1
    expect((result as any).tokens).toBe(1);
    await rm(projectRoot, { recursive: true });
    await rm(userRoot, { recursive: true });
  });

  it("throws and does not write on validation failure", async () => {
    const { projectRoot, userRoot } = await makeRoots();
    const registry = fakeRegistry();
    const handler = makeNewSkillHandler({ projectRoot, userRoot, registry });
    await expect(handler({ name: "Bad", description: "d", body: "b", scope: "user" }, { signal: new AbortController().signal, callId: "c", log: () => {} })).rejects.toThrow(/name must match/);
    // No directory created
    await expect(fsStat(join(userRoot, "Bad"))).rejects.toThrow();
    expect(registry.rescanCalls).toBe(0);
    await rm(projectRoot, { recursive: true });
    await rm(userRoot, { recursive: true });
  });

  it("throws and does not write on collision", async () => {
    const { projectRoot, userRoot } = await makeRoots();
    await mkdir(join(projectRoot, "exists"), { recursive: true });
    const registry = fakeRegistry();
    const handler = makeNewSkillHandler({ projectRoot, userRoot, registry });
    await expect(handler({ name: "exists", description: "d", body: "b", scope: "project" }, { signal: new AbortController().signal, callId: "c", log: () => {} })).rejects.toThrow(/already exists/);
    expect(registry.rescanCalls).toBe(0);
    await rm(projectRoot, { recursive: true });
    await rm(userRoot, { recursive: true });
  });

  it("wraps registry.rescan() errors with a message naming the written file", async () => {
    const { projectRoot, userRoot } = await makeRoots();
    const registry: SkillsRegistryService = {
      list: () => [],
      load: async () => { throw new Error("nope"); },
      register: () => () => {},
      rescan: async () => { throw new Error("disk broke"); },
    } as any;
    const handler = makeNewSkillHandler({ projectRoot, userRoot, registry });
    const expectedPath = join(projectRoot, "z", "SKILL.md");
    await expect(handler({ name: "z", description: "d", body: "b", scope: "project" }, { signal: new AbortController().signal, callId: "c", log: () => {} })).rejects.toThrow(new RegExp(`written to.*${expectedPath.replace(/\//g, "\\/")}`));
    // File was written despite the rescan failure.
    const exists = await fsStat(expectedPath);
    expect(exists.isFile()).toBe(true);
    await rm(projectRoot, { recursive: true });
    await rm(userRoot, { recursive: true });
  });

  it("uses write-then-rename so no SKILL.md.tmp-* file remains", async () => {
    const { projectRoot, userRoot } = await makeRoots();
    const registry = fakeRegistry({ listEntry: { name: "z", tokens: 2 } });
    const handler = makeNewSkillHandler({ projectRoot, userRoot, registry });
    await handler({ name: "z", description: "d", body: "b", scope: "project" }, { signal: new AbortController().signal, callId: "c", log: () => {} });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(projectRoot, "z"));
    expect(entries).toEqual(["SKILL.md"]);
    await rm(projectRoot, { recursive: true });
    await rm(userRoot, { recursive: true });
  });
});
