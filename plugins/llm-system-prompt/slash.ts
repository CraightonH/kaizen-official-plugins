import type { SystemPromptServiceImpl } from "./registry.ts";

interface SlashCtx {
  args: string;
  raw: string;
  signal: AbortSignal;
  emit: (event: string, payload: unknown) => Promise<void>;
  print: (text: string) => Promise<void>;
}

export interface PromptSlashOptions {
  registry: SystemPromptServiceImpl;
  reloadIdentity: () => Promise<void>;
}

export interface PromptSlashHandlers {
  show: (ctx: SlashCtx) => Promise<void>;
  reload: (ctx: SlashCtx) => Promise<void>;
  disable: (ctx: SlashCtx) => Promise<void>;
  enable: (ctx: SlashCtx) => Promise<void>;
}

export function makePromptSlashHandlers(opts: PromptSlashOptions): PromptSlashHandlers {
  const { registry, reloadIdentity } = opts;

  async function show(ctx: SlashCtx): Promise<void> {
    const stats = ctx.args.trim() === "--stats";
    const sections = registry.list().slice().sort((a, b) => a.priority - b.priority);

    const lines: string[] = [];
    lines.push(`# system prompt (generation: ${registry.generation()})`);
    lines.push("");

    for (const s of sections) {
      const header = s.title ? `[${s.id}, p=${s.priority}, title=${s.title}]` : `[${s.id}, p=${s.priority}]`;
      lines.push(`### ${header}`);
      const body = await registry.renderSection(s.id);
      if (body === undefined) {
        lines.push("(disabled or unknown)");
      } else {
        lines.push(body);
      }
      if (stats) lines.push(`-- ${s.id}: ${body?.length ?? 0} chars --`);
      lines.push("");
    }

    if (stats) lines.push(`generation: ${registry.generation()}`);
    await ctx.print(lines.join("\n"));
  }

  async function reload(ctx: SlashCtx): Promise<void> {
    await reloadIdentity();
    await ctx.print("identity reloaded");
  }

  async function disable(ctx: SlashCtx): Promise<void> {
    const id = ctx.args.trim();
    if (!id) {
      await ctx.print("usage: /prompt:disable <section-id>");
      return;
    }
    if (!registry.has(id)) {
      await ctx.print(`no section with id "${id}"`);
      return;
    }
    registry.disable(id);
    await ctx.print(`disabled section "${id}"`);
  }

  async function enable(ctx: SlashCtx): Promise<void> {
    const id = ctx.args.trim();
    if (!id) {
      await ctx.print("usage: /prompt:enable <section-id>");
      return;
    }
    if (!registry.has(id)) {
      await ctx.print(`no section with id "${id}"`);
      return;
    }
    registry.enable(id);
    await ctx.print(`enabled section "${id}"`);
  }

  return { show, reload, disable, enable };
}
