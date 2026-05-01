// plugins/llm-local-tools/tools.ts
import * as readMod from "./tools/read.ts";
import * as writeMod from "./tools/write.ts";
import * as createMod from "./tools/create.ts";
import * as editMod from "./tools/edit.ts";
import * as globMod from "./tools/glob.ts";
import * as grepMod from "./tools/grep.ts";
import * as bashMod from "./tools/bash.ts";
import type { ToolSchema } from "llm-events/public";

export interface ToolEntry {
  schema: ToolSchema;
  handler: (args: any, ctx: any) => Promise<unknown>;
}

export const ALL_TOOLS: ToolEntry[] = [
  { schema: readMod.schema, handler: readMod.handler },
  { schema: writeMod.schema, handler: writeMod.handler },
  { schema: createMod.schema, handler: createMod.handler },
  { schema: editMod.schema, handler: editMod.handler },
  { schema: globMod.schema, handler: globMod.handler },
  { schema: grepMod.schema, handler: grepMod.handler },
  { schema: bashMod.schema, handler: bashMod.handler },
];
