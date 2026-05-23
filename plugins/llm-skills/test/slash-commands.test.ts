import { describe, expect, test } from "bun:test";
import type {
  SkillManifest,
  SkillsRegistryService,
  SlashCommandHandler,
  SlashCommandManifest,
  SlashCommandContext,
  SlashRegistryEntry,
  SlashRegistryService,
} from "llm-contracts/public";
import { registerSlashCommands } from "../slash-commands.ts";

type Registered = { manifest: SlashCommandManifest; handler: SlashCommandHandler };

function makeFakeSlash() {
  const registered: Registered[] = [];
  const service: SlashRegistryService = {
    register(manifest, handler) {
      registered.push({ manifest, handler });
      return () => {
        const i = registered.findIndex((r) => r.manifest.name === manifest.name);
        if (i >= 0) registered.splice(i, 1);
      };
    },
    get(name): SlashRegistryEntry | undefined {
      const hit = registered.find((r) => r.manifest.name === name);
      return hit ? { manifest: hit.manifest, handler: hit.handler } : undefined;
    },
    list() {
      return registered.map((r) => r.manifest);
    },
  };
  return { service, registered };
}

function makeFakeRegistry(opts: {
  list?: SkillManifest[];
  bodies?: Record<string, string>;
} = {}): SkillsRegistryService {
  const entries = opts.list ?? [];
  const bodies = opts.bodies ?? {};
  return {
    list: () => entries,
    load: async (name) => {
      if (!(name in bodies)) throw new Error(`no body for ${name}`);
      return bodies[name]!;
    },
    register: () => () => {},
    rescan: async () => ({ changed: false, count: entries.length }),
  };
}

function makeCtx(args: string): { ctx: SlashCommandContext; prints: Array<{ text: string; markdown?: boolean }> } {
  const prints: Array<{ text: string; markdown?: boolean }> = [];
  const ctx: SlashCommandContext = {
    args,
    raw: `/skills:get ${args}`,
    signal: new AbortController().signal,
    emit: async () => {},
    print: async (text, opts) => {
      prints.push({ text, markdown: opts?.markdown });
    },
  };
  return { ctx, prints };
}

describe("registerSlashCommands", () => {
  test("registers /skills:list and /skills:get", () => {
    const slash = makeFakeSlash();
    const registry = makeFakeRegistry();
    const off = registerSlashCommands({
      registry,
      slash: slash.service,
      projectRoot: "/proj/.kaizen/skills",
      userRoot: "/home/u/.kaizen/skills",
    });
    expect(slash.registered.map((r) => r.manifest.name).sort()).toEqual([
      "skills:get",
      "skills:list",
    ]);
    expect(slash.registered.every((r) => r.manifest.source === "plugin")).toBe(true);
    off();
    expect(slash.registered).toEqual([]);
  });

  test("/skills:list with empty registry prints 'No skills registered.'", async () => {
    const slash = makeFakeSlash();
    const registry = makeFakeRegistry({ list: [] });
    registerSlashCommands({
      registry,
      slash: slash.service,
      projectRoot: "/proj/.kaizen/skills",
      userRoot: "/home/u/.kaizen/skills",
    });
    const listEntry = slash.registered.find((r) => r.manifest.name === "skills:list")!;
    const { ctx, prints } = makeCtx("");
    await listEntry.handler(ctx);
    expect(prints).toHaveLength(1);
    expect(prints[0]!.text).toBe("No skills registered.");
    expect(prints[0]!.markdown).toBe(true);
  });

  test("/skills:list prints `<name>` — <description> per skill, alpha sorted", async () => {
    const slash = makeFakeSlash();
    const registry = makeFakeRegistry({
      list: [
        { name: "zeta", description: "Last one" },
        { name: "alpha", description: "First one" },
        { name: "superpowers:brainstorming", description: "Brainstorm features" },
      ],
    });
    registerSlashCommands({
      registry,
      slash: slash.service,
      projectRoot: "/proj/.kaizen/skills",
      userRoot: "/home/u/.kaizen/skills",
    });
    const listEntry = slash.registered.find((r) => r.manifest.name === "skills:list")!;
    const { ctx, prints } = makeCtx("");
    await listEntry.handler(ctx);
    expect(prints).toHaveLength(1);
    expect(prints[0]!.text).toBe(
      "`alpha` — First one\n" +
      "`superpowers:brainstorming` — Brainstorm features\n" +
      "`zeta` — Last one"
    );
    expect(prints[0]!.markdown).toBe(true);
  });

  test("/skills:get with no args prints usage hint", async () => {
    const slash = makeFakeSlash();
    const registry = makeFakeRegistry({
      list: [{ name: "alpha", description: "Anything" }],
      bodies: { alpha: "body" },
    });
    registerSlashCommands({
      registry,
      slash: slash.service,
      projectRoot: "/proj/.kaizen/skills",
      userRoot: "/home/u/.kaizen/skills",
    });
    const getEntry = slash.registered.find((r) => r.manifest.name === "skills:get")!;
    const { ctx, prints } = makeCtx("   "); // whitespace-only counts as no arg
    await getEntry.handler(ctx);
    expect(prints).toHaveLength(1);
    expect(prints[0]!.text).toBe(
      "Usage: /skills:get <name>\nRun /skills:list to see what's available."
    );
  });
});
