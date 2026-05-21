import { readFile as fsReadFile } from "node:fs/promises";

export interface PersistCfgSvc {
  list(): Array<{ plugin: string; projectPath: string; projectExists: boolean }>;
  set(
    plugin: string,
    value: { allow: string[] },
    scope: "home" | "project",
  ): Promise<void>;
}

export interface PersistDeps {
  cfgSvc: PersistCfgSvc;
  /** Override for tests; defaults to node:fs/promises.readFile. */
  readFileFn?: (path: string, encoding: "utf8") => Promise<string>;
  log: (msg: string) => void;
}

/**
 * Appends `entry` to the project-scope `allow` list for `pluginName`, writing
 * only the project-scope delta — never the merged effective view. This avoids
 * persisting `defaults.json` and home-scope entries into the project file on
 * first write, which would silently "freeze" them as if the user had granted
 * them explicitly.
 *
 * Reads the on-disk project file directly because `ConfigStoreService.get()`
 * only exposes the merged view. If the file is missing or unreadable we treat
 * the project allow list as empty and log the reason.
 */
export async function persistProjectAllow(
  pluginName: string,
  entry: string,
  deps: PersistDeps,
): Promise<void> {
  const status = deps.cfgSvc.list().find((s) => s.plugin === pluginName);
  let projectAllow: string[] = [];

  if (status?.projectExists) {
    const read = deps.readFileFn ?? fsReadFile;
    try {
      const raw = await read(status.projectPath, "utf8");
      const parsed = JSON.parse(raw) as { plugins?: Record<string, { allow?: unknown }> };
      const a = parsed.plugins?.[pluginName]?.allow;
      if (Array.isArray(a)) {
        projectAllow = a.filter((s): s is string => typeof s === "string");
      }
    } catch (err) {
      deps.log(
        `llm-tool-approval: could not read project config for delta append (${(err as Error).message}); writing only the new entry`,
      );
    }
  }

  const merged = dedupeSort([...projectAllow, entry]);
  await deps.cfgSvc.set(pluginName, { allow: merged }, "project");
}

function dedupeSort(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}
