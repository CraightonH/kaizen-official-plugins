// plugins/llm-local-tools/tools.ts
import * as readMod from "./tools/read.ts";
import * as writeMod from "./tools/write.ts";
import * as createMod from "./tools/create.ts";
import * as editMod from "./tools/edit.ts";
import * as globMod from "./tools/glob.ts";
import * as grepMod from "./tools/grep.ts";
import * as bashMod from "./tools/bash.ts";
import * as webFetchMod from "./tools/web_fetch.ts";
import type { ToolSchema } from "llm-contracts/public";
import type { LlmLocalToolsConfig } from "./public.d.ts";

export interface ToolEntry {
  schema: ToolSchema;
  handler: (args: any, ctx: any) => Promise<unknown>;
}

/**
 * Construct the full tool set with `config` threaded into every config-aware
 * handler. `write` / `create` / `edit` have no tunable knobs today; they ship
 * their handlers verbatim.
 */
export function buildAllTools(config: LlmLocalToolsConfig): ReadonlyArray<ToolEntry> {
  return [
    { schema: readMod.schema,     handler: readMod.makeHandler(config) },
    { schema: writeMod.schema,    handler: writeMod.handler },
    { schema: createMod.schema,   handler: createMod.handler },
    { schema: editMod.schema,     handler: editMod.handler },
    { schema: globMod.schema,     handler: globMod.makeHandler(config) },
    { schema: grepMod.schema,     handler: grepMod.makeHandler({ config }) },
    { schema: bashMod.schema,     handler: bashMod.makeHandler(config) },
    { schema: webFetchMod.schema, handler: webFetchMod.makeHandler(config) },
  ];
}
