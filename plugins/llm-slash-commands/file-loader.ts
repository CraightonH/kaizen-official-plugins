import { parseMarkdownCommandFile } from "./frontmatter.ts";
import type { SlashRegistryService, SlashCommandHandler, SlashCommandContext } from "./registry.ts";
import { DuplicateRegistrationError } from "./errors.ts";

export interface DriverLike {
  runConversation(input: {
    systemPrompt?: string;
    messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[];
    signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface FileLoaderDeps {
  home: string;
  cwd: string;
  registry: SlashRegistryService;
  readDir: (path: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  getDriver: () => DriverLike | undefined;
}

interface DiscoveredFile {
  scope: "user" | "project";
  dir: string;
  fileName: string;
  fullPath: string;
}

export async function loadFileCommands(deps: FileLoaderDeps): Promise<string[]> {
  const warnings: string[] = [];
  const userOffs = new Map<string, () => void>();
  const userDir = `${deps.home.replace(/\/$/, "")}/.kaizen/commands`;
  const projectDir = `${deps.cwd.replace(/\/$/, "")}/.kaizen/commands`;

  for (const f of await listMarkdown(deps, userDir, "user")) {
    await loadOne(deps, f, warnings, userOffs, /*allowReplace*/ false);
  }
  for (const f of await listMarkdown(deps, projectDir, "project")) {
    await loadOne(deps, f, warnings, userOffs, /*allowReplace*/ true);
  }
  return warnings;
}

async function listMarkdown(deps: FileLoaderDeps, dir: string, scope: "user" | "project"): Promise<DiscoveredFile[]> {
  let entries: string[];
  try { entries = await deps.readDir(dir); }
  catch { return []; }
  return entries
    .filter((n) => n.endsWith(".md"))
    .map((n) => ({ scope, dir, fileName: n, fullPath: `${dir}/${n}` }));
}

async function loadOne(
  deps: FileLoaderDeps,
  f: DiscoveredFile,
  warnings: string[],
  userOffs: Map<string, () => void>,
  allowReplace: boolean,
): Promise<void> {
  const name = f.fileName.replace(/\.md$/, "");
  let raw: string;
  try { raw = await deps.readFile(f.fullPath); }
  catch (e) { warnings.push(`${f.fullPath}: failed to read: ${(e as Error).message}`); return; }

  const parsed = parseMarkdownCommandFile(f.fullPath, raw);
  if (!parsed.ok) { warnings.push(parsed.reason); return; }

  const existing = deps.registry.get(name);
  if (existing) {
    if (allowReplace && existing.manifest.source === "file") {
      const off = userOffs.get(name);
      if (off) { off(); userOffs.delete(name); }
    } else {
      warnings.push(`${f.fullPath}: skipped — name "${name}" is reserved (already registered by ${existing.manifest.source}).`);
      return;
    }
  }

  const handler = makeHandler(name, parsed.argumentsRequired, parsed.usage, parsed.body, deps);
  try {
    const off = deps.registry.register(
      { name, description: parsed.description, usage: parsed.usage, source: "file", filePath: f.fullPath },
      handler,
    );
    if (f.scope === "user") userOffs.set(name, off);
  } catch (e) {
    if (e instanceof DuplicateRegistrationError) warnings.push(`${f.fullPath}: duplicate registration for "${name}".`);
    else warnings.push(`${f.fullPath}: registration failed: ${(e as Error).message}`);
  }
}

function makeHandler(
  name: string,
  argumentsRequired: boolean,
  usage: string | undefined,
  body: string,
  deps: FileLoaderDeps,
): SlashCommandHandler {
  return async (ctx: SlashCommandContext) => {
    if (argumentsRequired && ctx.args.trim() === "") {
      const u = usage ? ` ${usage}` : "";
      await ctx.print(`Command /${name} requires arguments. Usage: /${name}${u}`);
      return;
    }
    const rendered = body.split("{{args}}").join(ctx.args);
    await ctx.emit("conversation:user-message", { message: { role: "user", content: rendered } });
    const driver = deps.getDriver();
    if (driver) {
      await driver.runConversation({
        messages: [{ role: "user", content: rendered }],
        signal: ctx.signal,
      });
    }
  };
}
