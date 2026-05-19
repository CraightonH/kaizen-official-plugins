import type { AxiomEntry, AxiomsRegistryService } from "./public.d.ts";

export interface SlashCommandManifestLike {
  name: string;
  description: string;
  source?: string;
  usage?: string;
}

export interface SlashCommandContextLike {
  args: string;
  print(text: string): void;
  error(text: string): void;
}

export interface SlashRegistryLike {
  register(
    manifest: SlashCommandManifestLike,
    handler: (ctx: SlashCommandContextLike) => Promise<void>,
  ): () => void;
}

function groupByScope(entries: readonly AxiomEntry[]): Map<string, AxiomEntry[]> {
  const out = new Map<string, AxiomEntry[]>();
  for (const e of entries) {
    const arr = out.get(e.scope) ?? [];
    arr.push(e);
    out.set(e.scope, arr);
  }
  return out;
}

function renderList(entries: readonly AxiomEntry[]): string {
  if (entries.length === 0) return "No axioms in this session.";
  const groups = groupByScope(entries);
  const out: string[] = [];
  for (const [scope, items] of groups) {
    out.push(`## ${scope}`);
    for (const e of items) out.push(`- **${e.id}** — ${e.statement}`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}

function renderShow(e: AxiomEntry): string {
  const out: string[] = [];
  out.push(`# ${e.id}`);
  out.push("");
  out.push(`**Statement:** ${e.statement}`);
  out.push(`**Scope:** ${e.scope}`);
  out.push(`**Premises:**`);
  e.premises.forEach((p, i) => { out.push(`  ${i + 1}. ${p}`); });
  out.push(`**Reasoning:** ${e.reasoning}`);
  out.push("");
  out.push(`*Derived: ${new Date(e.derivedAt).toISOString()}*`);
  if (e.amendedAt) out.push(`*Amended: ${new Date(e.amendedAt).toISOString()}*`);
  return out.join("\n");
}

export function registerSlashCommands(
  reg: SlashRegistryLike,
  store: AxiomsRegistryService,
): Array<() => void> {
  const offs: Array<() => void> = [];

  offs.push(reg.register(
    { name: "axioms:list", description: "List axioms recorded in the current session", source: "plugin" },
    async (ctx) => { ctx.print(renderList(store.list())); },
  ));

  offs.push(reg.register(
    { name: "axioms:show", description: "Show full detail for one axiom", source: "plugin", usage: "<id>" },
    async (ctx) => {
      const id = (ctx.args ?? "").trim();
      if (id.length === 0) {
        ctx.error("usage: /axioms:show <id>");
        return;
      }
      const e = store.get(id);
      if (!e) {
        ctx.error(`axiom "${id}" not found in this session`);
        return;
      }
      ctx.print(renderShow(e));
    },
  ));

  offs.push(reg.register(
    { name: "axioms:clear", description: "Drop all axioms in the current session", source: "plugin" },
    async (ctx) => {
      const before = store.list().length;
      if (before === 0) {
        ctx.print("No axioms in this session to clear.");
        return;
      }
      await store.clear();
      ctx.print(`Cleared ${before} axiom${before === 1 ? "" : "s"} from the current session.`);
    },
  ));

  return offs;
}
