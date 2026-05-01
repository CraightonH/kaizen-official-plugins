import { compile } from "json-schema-to-typescript";
import type { ToolSchema } from "llm-events/public";

const cache = new Map<string, string>();

export function _resetCacheForTest(): void { cache.clear(); }

function stableKey(tools: ToolSchema[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify(sorted.map((t) => [t.name, t.description ?? "", t.parameters ?? null]));
}

function isIdent(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function pascal(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join("") || "Tool";
}

function uniqInterfaceName(base: string, used: Set<string>): string {
  if (!used.has(base)) { used.add(base); return base; }
  let i = 2;
  while (used.has(`${base}${i}`)) i++;
  const name = `${base}${i}`;
  used.add(name);
  return name;
}

async function compileParamsInterface(name: string, schema: unknown): Promise<string> {
  // json-schema-to-typescript needs a title to emit `interface <Name>`.
  const root = { ...(schema as object), title: name } as any;
  const out = await compile(root, name, {
    bannerComment: "",
    additionalProperties: false,
    declareExternallyReferenced: false,
    enableConstEnums: false,
    format: false,
    strictIndexSignatures: true,
    unknownAny: false,
  });
  return out.trim();
}

function isFreeformObject(schema: any): boolean {
  return schema && schema.type === "object" && (!schema.properties || Object.keys(schema.properties).length === 0);
}

export async function renderDts(tools: ToolSchema[]): Promise<string> {
  const key = stableKey(tools);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const used = new Set<string>();
  const interfaceBlocks: string[] = [];
  const methodLines: string[] = [];

  for (const tool of sorted) {
    const params = tool.parameters as any;
    let paramTs: string;
    if (!params) {
      paramTs = ""; // method renders as `name()`
    } else if (isFreeformObject(params)) {
      paramTs = "args: Record<string, unknown>";
    } else {
      const ifaceName = uniqInterfaceName(`${pascal(tool.name)}Args`, used);
      const block = await compileParamsInterface(ifaceName, params);
      interfaceBlocks.push(block);
      paramTs = `args: ${ifaceName}`;
    }

    const methodKey = isIdent(tool.name) ? tool.name : JSON.stringify(tool.name);
    const jsdoc = tool.description ? `  /** ${tool.description.replace(/\*\//g, "*\\/")} */\n` : "";
    methodLines.push(`${jsdoc}  ${methodKey}(${paramTs}): Promise<unknown>;`);
  }

  const out = [
    ...interfaceBlocks,
    "",
    "declare const kaizen: {",
    "  tools: {",
    ...methodLines,
    "  };",
    "};",
    "",
  ].join("\n");

  cache.set(key, out);
  return out;
}
