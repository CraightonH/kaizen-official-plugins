import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { resolveIdentity, FALLBACK_PREFIX } from "../identity.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("identity — file resolution", () => {
  it("returns the global file body when only the global file exists", async () => {
    const r = resolveIdentity({
      globalPath: join(FIXTURES, "identity-global-only", "system-prompt.md"),
      projectPath: join(FIXTURES, "does-not-exist", "system-prompt.md"),
    });
    await r.reload();
    const out = await r.section.render();
    expect(out).toContain("GlobalAssistant");
    expect(out).not.toContain("Project context");
  });

  it("returns the project file body when only the project file exists", async () => {
    const r = resolveIdentity({
      globalPath: join(FIXTURES, "does-not-exist", "system-prompt.md"),
      projectPath: join(FIXTURES, "identity-project-only", "system-prompt.md"),
    });
    await r.reload();
    const out = await r.section.render();
    expect(out).toContain("Rust kernel");
    expect(out).not.toContain("Project context");
  });

  it("concatenates both with a `## Project context` header when both exist", async () => {
    const r = resolveIdentity({
      globalPath: join(FIXTURES, "identity-both/global/system-prompt.md"),
      projectPath: join(FIXTURES, "identity-both/project/system-prompt.md"),
    });
    await r.reload();
    const out = await r.section.render();
    const globalIdx = out.indexOf("GlobalAssistant");
    const headerIdx = out.indexOf("## Project context");
    const projectIdx = out.indexOf("Rust kernel");
    expect(globalIdx).toBeGreaterThanOrEqual(0);
    expect(headerIdx).toBeGreaterThan(globalIdx);
    expect(projectIdx).toBeGreaterThan(headerIdx);
  });

  it("uses the hard-coded fallback when neither file exists", async () => {
    const r = resolveIdentity({
      globalPath: join(FIXTURES, "does-not-exist", "system-prompt.md"),
      projectPath: join(FIXTURES, "does-not-exist", "system-prompt.md"),
    });
    await r.reload();
    const out = await r.section.render();
    expect(out).toContain(FALLBACK_PREFIX);
  });
});

describe("identity — date interpolation", () => {
  it("the fallback contains today's ISO date (YYYY-MM-DD)", async () => {
    const r = resolveIdentity({
      globalPath: join(FIXTURES, "does-not-exist", "system-prompt.md"),
      projectPath: join(FIXTURES, "does-not-exist", "system-prompt.md"),
    });
    await r.reload();
    const out = await r.section.render();
    const today = new Date().toISOString().slice(0, 10);
    expect(out).toContain(today);
  });
});

describe("identity — section shape", () => {
  it("registers id 'identity' at priority 10 with no title", async () => {
    const r = resolveIdentity({
      globalPath: join(FIXTURES, "identity-global-only", "system-prompt.md"),
      projectPath: join(FIXTURES, "does-not-exist", "system-prompt.md"),
    });
    expect(r.section.id).toBe("identity");
    expect(r.section.priority).toBe(10);
    expect(r.section.title).toBeUndefined();
  });
});

describe("identity — env disable", () => {
  it("KAIZEN_SYSTEM_PROMPT_DISABLE=1 renders empty", async () => {
    const r = resolveIdentity({
      globalPath: join(FIXTURES, "identity-global-only", "system-prompt.md"),
      projectPath: join(FIXTURES, "does-not-exist", "system-prompt.md"),
      env: { KAIZEN_SYSTEM_PROMPT_DISABLE: "1" },
    });
    await r.reload();
    const out = await r.section.render();
    expect(out).toBe("");
  });
});
