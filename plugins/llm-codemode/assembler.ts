import { createHash } from "node:crypto";
import type { ToolRegistration, ToolSource } from "llm-tools-registry/public";
import { renderToolsDts } from "./dts-render.ts";

const PREAMBLE =
  "You have access to a sandboxed TypeScript runtime. To use a tool, write a single ```typescript code block. " +
  "The code is executed in order; the value of the last expression (or any explicit `return` from a top-level " +
  "statement) is returned to you as the tool result. Use `console.log` to surface intermediate output. " +
  "Only one set of ```typescript blocks per turn will be executed; if you write none, your reply is treated as a " +
  "final answer to the user.\n\n" +
  "After you emit a code block, you will see a message from the user starting with `[code execution result]`. " +
  "Treat it as the runtime's response, not a new request from the human.";

export function normalizeServerName(name: string): string {
  let n = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(n)) n = `_${n}`;
  return n;
}

export interface SurfaceGroups {
  local: ToolRegistration[];
  mcp: Record<string, ToolRegistration[]>;
  agents: ToolRegistration[];
  skills: ToolRegistration[];
  memory: ToolRegistration[];
  conflicts: Array<{ normalized: string; servers: string[] }>;
}

export function groupBySource(regs: ReadonlyArray<ToolRegistration>): SurfaceGroups {
  const groups: SurfaceGroups = {
    local: [],
    mcp: {},
    agents: [],
    skills: [],
    memory: [],
    conflicts: [],
  };
  const normalizedToRaw = new Map<string, Set<string>>();

  for (const r of regs) {
    const s = r.source as ToolSource;
    switch (s.kind) {
      case "local":
        groups.local.push(r);
        break;
      case "mcp": {
        const norm = normalizeServerName(s.server);
        if (!groups.mcp[norm]) groups.mcp[norm] = [];
        groups.mcp[norm]!.push(r);
        if (!normalizedToRaw.has(norm)) normalizedToRaw.set(norm, new Set());
        normalizedToRaw.get(norm)!.add(s.server);
        break;
      }
      case "agent":
        groups.agents.push(r);
        break;
      case "skill":
        groups.skills.push(r);
        break;
      case "memory":
        groups.memory.push(r);
        break;
    }
  }

  for (const [norm, raws] of normalizedToRaw) {
    if (raws.size > 1) {
      groups.conflicts.push({ normalized: norm, servers: [...raws] });
    }
  }

  return groups;
}

function sortByName(arr: ToolRegistration[]): ToolRegistration[] {
  return [...arr].sort((a, b) => a.schema.name.localeCompare(b.schema.name, "en", { sensitivity: "base" }));
}

export function surfaceHash(regs: ReadonlyArray<ToolRegistration>): string {
  const sorted = sortByName([...regs]);
  const canonical = sorted.map((r) => ({
    name: r.schema.name,
    description: r.schema.description ?? "",
    tags: (r.schema as any).tags ?? [],
    source: r.source,
    parameters: r.schema.parameters ?? null,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export async function renderSurface(regs: ReadonlyArray<ToolRegistration>): Promise<string> {
  const groups = groupBySource(regs);

  const namespaceLines: string[] = ["declare const kaizen: {"];

  if (groups.local.length > 0) {
    namespaceLines.push("  // kaizen.tools");
    namespaceLines.push("  tools: {");
    namespaceLines.push(await renderToolsDts(sortByName(groups.local).map((r) => r.schema), { indent: "    " }));
    namespaceLines.push("  };");
  }

  const mcpServers = Object.keys(groups.mcp).sort();
  if (mcpServers.length > 0) {
    namespaceLines.push("  // kaizen.mcp");
    namespaceLines.push("  mcp: {");
    for (const server of mcpServers) {
      namespaceLines.push(`    // kaizen.mcp.${server}`);
      namespaceLines.push(`    ${server}: {`);
      namespaceLines.push(await renderToolsDts(sortByName(groups.mcp[server]!).map((r) => r.schema), { indent: "      " }));
      namespaceLines.push(`    };`);
    }
    namespaceLines.push("  };");
  }

  if (groups.agents.length > 0) {
    namespaceLines.push("  // kaizen.agents");
    namespaceLines.push("  agents: {");
    namespaceLines.push(await renderToolsDts(sortByName(groups.agents).map((r) => r.schema), { indent: "    " }));
    namespaceLines.push("  };");
  }

  if (groups.skills.length > 0) {
    namespaceLines.push("  // kaizen.skills");
    namespaceLines.push("  skills: {");
    namespaceLines.push(await renderToolsDts(sortByName(groups.skills).map((r) => r.schema), { indent: "    " }));
    namespaceLines.push("  };");
  }

  if (groups.memory.length > 0) {
    namespaceLines.push("  // kaizen.memory");
    namespaceLines.push("  memory: {");
    namespaceLines.push(await renderToolsDts(sortByName(groups.memory).map((r) => r.schema), { indent: "    " }));
    namespaceLines.push("  };");
  }

  namespaceLines.push("};");

  const blocks: string[] = [];
  blocks.push(PREAMBLE);
  blocks.push("");
  blocks.push("The following API is available:");
  blocks.push("");
  blocks.push("```typescript");
  blocks.push(namespaceLines.join("\n"));
  blocks.push("```");

  return blocks.join("\n");
}
