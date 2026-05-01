import { regenerateIndex } from "./catalog.ts";
import { makeStore } from "./store.ts";
import type { MemoryStoreService } from "./public.d.ts";

export interface MemoryServiceDeps {
  globalDir: string;
  projectDir: string | null;
  log: (msg: string) => void;
}

export function makeMemoryStore(deps: MemoryServiceDeps): MemoryStoreService {
  return makeStore({
    globalDir: deps.globalDir,
    projectDir: deps.projectDir,
    regenerateIndex: (dir: string) => regenerateIndex(dir),
    log: deps.log,
  });
}
