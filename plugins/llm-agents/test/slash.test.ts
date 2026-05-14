import { describe, it, expect } from "bun:test";
import type { SlashCommandContext } from "llm-contracts/public";
import { makeSlashHandlers } from "../slash.ts";
import type { InternalAgentManifest } from "../frontmatter.ts";

function mkManifest(over: Partial<InternalAgentManifest> & { name: string }): InternalAgentManifest {
  return {
    name: over.name,
    description: over.description ?? `desc for ${over.name}`,
    systemPrompt: over.systemPrompt ?? `prompt for ${over.name}`,
    toolFilter: over.toolFilter,
    sourcePath: over.sourcePath ?? `/agents/${over.name}.md`,
    scope: over.scope ?? "user",
    modelOverride: over.modelOverride,
  };
}

function fakeRegistry(manifests: InternalAgentManifest[]) {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  return {
    service: {
      list: () => manifests.map(({ sourcePath, scope, modelOverride, ...rest }) => rest),
      register: () => () => {},
    },
    getInternal: (name: string) => byName.get(name),
  };
}

function fakeCmdCtx(args = ""): SlashCommandContext & { printed: string[] } {
  const printed: string[] = [];
  return {
    args,
    raw: `/agents:list ${args}`.trim(),
    signal: new AbortController().signal,
    emit: async () => {},
    print: async (text: string) => { printed.push(text); },
    printed,
  } as unknown as SlashCommandContext & { printed: string[] };
}

describe("listHandler", () => {
  it("prints 'No agents registered.' when registry is empty", async () => {
    const { listHandler } = makeSlashHandlers({ registry: fakeRegistry([]) });
    const ctx = fakeCmdCtx();
    await listHandler(ctx);
    expect(ctx.printed).toEqual(["No agents registered."]);
  });

  it("prints alphabetized bullets with scope tags for user/project/runtime agents", async () => {
    const reg = fakeRegistry([
      mkManifest({ name: "db-migrator", description: "Plans and applies schema migrations safely.", scope: "project", sourcePath: "/proj/.kaizen/agents/db-migrator.md" }),
      mkManifest({ name: "code-reviewer", description: "Reviews diffs.", scope: "user", sourcePath: "/home/u/.kaizen/agents/code-reviewer.md" }),
      mkManifest({ name: "runtime:router:main", description: "Routes between specialists.", scope: "user", sourcePath: "<runtime>" }),
    ]);
    const { listHandler } = makeSlashHandlers({ registry: reg });
    const ctx = fakeCmdCtx();
    await listHandler(ctx);
    expect(ctx.printed).toHaveLength(1);
    expect(ctx.printed[0]).toBe(
      "- **`code-reviewer`** [user] — Reviews diffs.\n" +
      "- **`db-migrator`** [project] — Plans and applies schema migrations safely.\n" +
      "- **`runtime:router:main`** [runtime] — Routes between specialists.",
    );
  });

  it("ignores args", async () => {
    const reg = fakeRegistry([mkManifest({ name: "a", description: "A." })]);
    const { listHandler } = makeSlashHandlers({ registry: reg });
    const ctx = fakeCmdCtx("garbage   args");
    await listHandler(ctx);
    expect(ctx.printed[0]).toBe("- **`a`** [user] — A.");
  });
});

describe("showHandler", () => {
  it("prints usage when args are empty/whitespace", async () => {
    const { showHandler } = makeSlashHandlers({ registry: fakeRegistry([]) });
    const ctx = fakeCmdCtx("   ");
    await showHandler(ctx);
    expect(ctx.printed).toEqual(["Usage: /agents:show <name>"]);
  });

  it("prints unknown-agent message when name is not in registry", async () => {
    const reg = fakeRegistry([mkManifest({ name: "a" })]);
    const { showHandler } = makeSlashHandlers({ registry: reg });
    const ctx = fakeCmdCtx("does-not-exist");
    await showHandler(ctx);
    expect(ctx.printed).toEqual([
      "Unknown agent: does-not-exist. Run /agents:list to see registered agents.",
    ]);
  });

  it("renders a file-loaded agent with full system prompt and tool filter (tags + names)", async () => {
    const reg = fakeRegistry([
      mkManifest({
        name: "code-reviewer",
        description: "Reviews diffs.",
        systemPrompt: "You are a focused code reviewer.\nFollow the rules.",
        toolFilter: { tags: ["read-only"], names: ["read_file", "grep*"] },
        scope: "user",
        sourcePath: "/home/u/.kaizen/agents/code-reviewer.md",
      }),
    ]);
    const { showHandler } = makeSlashHandlers({ registry: reg });
    const ctx = fakeCmdCtx("code-reviewer");
    await showHandler(ctx);
    expect(ctx.printed).toHaveLength(1);
    expect(ctx.printed[0]).toBe(
      "**Agent**: code-reviewer\n" +
      "**Scope**: user\n" +
      "**Source**: /home/u/.kaizen/agents/code-reviewer.md\n" +
      "\n" +
      "**Description**: Reviews diffs.\n" +
      "\n" +
      "**Tool filter**:\n" +
      "- Tags: read-only\n" +
      "- Names: read_file, grep*\n" +
      "\n" +
      "**System prompt**:\n" +
      "```\n" +
      "You are a focused code reviewer.\nFollow the rules.\n" +
      "```",
    );
  });

  it("renders a runtime agent with sourcePath '<runtime>' and 'none' tool filter", async () => {
    const reg = fakeRegistry([
      mkManifest({
        name: "runtime:router:main",
        description: "Routes.",
        systemPrompt: "Router.",
        sourcePath: "<runtime>",
        toolFilter: undefined,
      }),
    ]);
    const { showHandler } = makeSlashHandlers({ registry: reg });
    const ctx = fakeCmdCtx("runtime:router:main");
    await showHandler(ctx);
    expect(ctx.printed[0]).toContain("**Scope**: runtime");
    expect(ctx.printed[0]).toContain("**Source**: <runtime>");
    expect(ctx.printed[0]).toContain(
      "Tool filter: none (agent inherits parent's tool view, plus always-on dispatch_agent / load_skill).",
    );
    expect(ctx.printed[0]).not.toContain("- Tags:");
    expect(ctx.printed[0]).not.toContain("- Names:");
  });

  it("omits Names: sub-bullet when toolFilter has only tags", async () => {
    const reg = fakeRegistry([
      mkManifest({ name: "a", toolFilter: { tags: ["read-only"] } }),
    ]);
    const { showHandler } = makeSlashHandlers({ registry: reg });
    const ctx = fakeCmdCtx("a");
    await showHandler(ctx);
    expect(ctx.printed[0]).toContain("- Tags: read-only");
    expect(ctx.printed[0]).not.toContain("- Names:");
  });

  it("omits Tags: sub-bullet when toolFilter has only names", async () => {
    const reg = fakeRegistry([
      mkManifest({ name: "a", toolFilter: { names: ["read_*"] } }),
    ]);
    const { showHandler } = makeSlashHandlers({ registry: reg });
    const ctx = fakeCmdCtx("a");
    await showHandler(ctx);
    expect(ctx.printed[0]).toContain("- Names: read_*");
    expect(ctx.printed[0]).not.toContain("- Tags:");
  });
});
