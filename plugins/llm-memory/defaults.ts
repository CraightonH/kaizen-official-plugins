import type { MemoryConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: MemoryConfig = Object.freeze({
  globalDir: null,
  projectDir: null,
  injectionByteCap: 2048,
  autoExtract: false,
  extractTriggers: ["from now on", "remember that", "always", "never", "i prefer", "my "],
  denyTypes: [],
  staleTempMs: 60_000,
}) as MemoryConfig;
