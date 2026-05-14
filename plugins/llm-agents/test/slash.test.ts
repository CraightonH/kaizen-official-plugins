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
