// plugins/kaizen-config/store.ts
import type {
  ConfigSpec,
  ConfigScope,
  ConfigStoreService,
  ConfigStatus,
  SecretsRegistryService,
  FieldSchema,
} from "llm-contracts/public";
import { isSecretRef } from "llm-contracts/public";
import { selectBackend } from "./secrets/select-backend.ts";
import { validate, type ConfigSchema } from "./schema.ts";
import { applyEnvOverrides, type ResolutionSource } from "./envvars.ts";
import { mergePluginSection, type HarnessConfigFile } from "./atomic-write.ts";

export interface StoreDeps {
  homePath: string;
  projectPath: string;
  readFile: (path: string) => string;          // throws ENOENT when missing
  writeFile: (path: string, value: unknown) => void;
  watchFile: (path: string, cb: () => void) => () => void;
  env: Record<string, string | undefined>;
  log: (msg: string) => void;
  registry?: SecretsRegistryService;
}

interface Entry {
  spec: ConfigSpec<unknown>;
  cachedValue: unknown;
  cachedResolution: Record<string, ResolutionSource>;
  watchers: Set<(v: unknown) => void>;
}

interface LayerState {
  file: HarnessConfigFile;
  exists: boolean;
}

export function createStore(deps: StoreDeps): ConfigStoreService {
  const entries = new Map<string, Entry>();
  let home = safeRead(deps, deps.homePath);
  let project = safeRead(deps, deps.projectPath);

  let readyPromise: Promise<void> | null = null;

  const recomputeAll = () => {
    readyPromise = null;
    home = safeRead(deps, deps.homePath);
    project = safeRead(deps, deps.projectPath);
    for (const [name, entry] of entries) {
      const { value, resolution, ok } = resolve(name, entry.spec, home.file, project.file, deps);
      if (!ok) continue;
      entry.cachedValue = value;
      entry.cachedResolution = resolution;
      for (const cb of entry.watchers) cb(value);
    }
  };

  const resolveRefsForEntry = async (entry: Entry): Promise<void> => {
    const registry = deps.registry;
    if (!registry) return;
    const current = entry.cachedValue as Record<string, unknown>;
    if (!current || typeof current !== "object") return;
    for (const [k, v] of Object.entries(current)) {
      if (!isSecretRef(v)) continue;
      const colon = v.$ref.indexOf(":");
      const scheme = colon > 0 ? v.$ref.slice(0, colon) : "";
      if (!registry.has(scheme)) continue;
      try {
        const plaintext = await registry.resolve(v);
        (current as Record<string, unknown>)[k] = plaintext;
      } catch (err) {
        deps.log(`kaizen-config: failed to resolve ${v.$ref} for '${entry.spec.plugin}': ${(err as Error).message}`);
      }
    }
    for (const cb of entry.watchers) cb(entry.cachedValue);
  };

  const resolveAll = async (): Promise<void> => {
    for (const entry of entries.values()) {
      await resolveRefsForEntry(entry);
    }
  };

  const watchHome = deps.watchFile(deps.homePath, recomputeAll);
  const watchProject = deps.watchFile(deps.projectPath, recomputeAll);
  // teardown handled by index.ts on plugin teardown
  void watchHome; void watchProject;

  return {
    register<T>(spec: ConfigSpec<T>): void {
      if (entries.has(spec.plugin)) {
        throw new Error(`kaizen-config: plugin '${spec.plugin}' already registered`);
      }
      const { value, resolution } = resolve(
        spec.plugin,
        spec as ConfigSpec<unknown>,
        home.file,
        project.file,
        deps,
      );
      entries.set(spec.plugin, {
        spec: spec as ConfigSpec<unknown>,
        cachedValue: value,
        cachedResolution: resolution,
        watchers: new Set(),
      });
    },
    get<T>(plugin: string): T {
      const e = entries.get(plugin);
      if (!e) throw new Error(`kaizen-config: plugin '${plugin}' is not registered`);
      return e.cachedValue as T;
    },
    async set<T>(plugin: string, partial: Partial<T>, scope: ConfigScope = "home"): Promise<void> {
      const e = entries.get(plugin);
      if (!e) throw new Error(`kaizen-config: plugin '${plugin}' is not registered`);
      const path = scope === "home" ? deps.homePath : deps.projectPath;
      const current = scope === "home" ? home.file : project.file;

      const schema = e.spec.schema as Record<string, FieldSchema | undefined> | undefined;
      const toFile: Record<string, unknown> = {};
      const secretWrites: Array<{ key: string; value: string }> = [];
      for (const [k, v] of Object.entries(partial as Record<string, unknown>)) {
        const fs = schema?.[k];
        const isSecretField = fs && fs.type === "string" && fs.secret === true;
        if (!isSecretField) { toFile[k] = v; continue; }
        if (typeof v !== "string") {
          if (isSecretRef(v)) { toFile[k] = v; continue; }
          throw new Error(`kaizen-config: secret field '${plugin}.${k}' must be set with a string value`);
        }
        secretWrites.push({ key: k, value: v });
      }

      if (secretWrites.length > 0) {
        if (!deps.registry) throw new Error("kaizen-config: no secrets registry available; cannot set secret fields");
        const kaizenSelf = entries.get("kaizen-config");
        const configured = (kaizenSelf?.cachedValue as { defaultSecretBackend?: string } | undefined)?.defaultSecretBackend;
        const available = deps.registry.schemes();
        const readOnly = deps.registry.readOnlySchemes();
        const pick = selectBackend({ configured, available, readOnly });
        if (!pick.ok) throw new Error(`kaizen-config: ${pick.error}`);
        for (const { key, value } of secretWrites) {
          const ref = await deps.registry.store(pick.scheme, `${plugin}/${key}`, value);
          toFile[key] = ref;
        }
      }

      const next = mergePluginSection(current, plugin, toFile);
      const probeHome = scope === "home" ? next : home.file;
      const probeProject = scope === "project" ? next : project.file;
      const { ok, errors } = resolve(plugin, e.spec, probeHome, probeProject, deps);
      if (!ok) {
        throw new Error(
          `kaizen-config: validation failed for '${plugin}': ${errors!.map((er) => `${er.path}: ${er.message}`).join("; ")}`,
        );
      }
      deps.writeFile(path, next);
      if (scope === "home") home = { file: next, exists: true };
      else project = { file: next, exists: true };
      const r = resolve(plugin, e.spec, home.file, project.file, deps);
      e.cachedValue = r.value;
      e.cachedResolution = r.resolution;
      const cv = e.cachedValue as Record<string, unknown>;
      for (const { key, value } of secretWrites) cv[key] = value;
      for (const cb of e.watchers) cb(e.cachedValue);
    },
    async unset(plugin: string, key: string, scope: ConfigScope = "home"): Promise<void> {
      const e = entries.get(plugin);
      if (!e) throw new Error(`kaizen-config: plugin '${plugin}' is not registered`);
      const path = scope === "home" ? deps.homePath : deps.projectPath;
      const current = scope === "home" ? home.file : project.file;
      const section = { ...(current.plugins?.[plugin] ?? {}) };
      const wasRef = isSecretRef(section[key]);
      const refValue = section[key] as { $ref: string } | undefined;
      delete section[key];
      const nextPlugins = { ...current.plugins, [plugin]: section };
      const next = { ...current, plugins: nextPlugins };
      deps.writeFile(path, next);
      if (scope === "home") home = { file: next, exists: true };
      else project = { file: next, exists: true };
      if (wasRef && refValue && deps.registry) {
        try { await deps.registry.delete(refValue); }
        catch (err) { deps.log(`kaizen-config: backend delete failed for ${refValue.$ref}: ${(err as Error).message}`); }
      }
      const r = resolve(plugin, e.spec, home.file, project.file, deps);
      e.cachedValue = r.value;
      e.cachedResolution = r.resolution;
      for (const cb of e.watchers) cb(e.cachedValue);
    },
    watch<T>(plugin: string, cb: (v: T) => void): () => void {
      const e = entries.get(plugin);
      if (!e) throw new Error(`kaizen-config: plugin '${plugin}' is not registered`);
      e.watchers.add(cb as (v: unknown) => void);
      return () => { e.watchers.delete(cb as (v: unknown) => void); };
    },
    list(): ConfigStatus[] {
      return [...entries.entries()].map(([plugin, e]) => ({
        plugin,
        homePath: deps.homePath,
        projectPath: deps.projectPath,
        homeExists: home.exists,
        projectExists: project.exists,
        resolution: e.cachedResolution,
      }));
    },
    ready(): Promise<void> {
      if (!readyPromise) readyPromise = resolveAll();
      return readyPromise;
    },
    getSpec(plugin: string): ConfigSpec<unknown> | undefined {
      return entries.get(plugin)?.spec;
    },
  };
}

function safeRead(deps: StoreDeps, path: string): LayerState {
  try {
    const raw = deps.readFile(path);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { file: { plugins: {} }, exists: true };
    const file: HarnessConfigFile = { plugins: {}, ...parsed, plugins: parsed.plugins ?? {} };
    return { file, exists: true };
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      deps.log(`kaizen-config: failed to read ${path}: ${err.message}`);
    }
    return { file: { plugins: {} }, exists: false };
  }
}

interface ResolveResult {
  ok: boolean;
  value: unknown;
  resolution: Record<string, ResolutionSource>;
  errors?: { path: string; message: string }[];
}

function resolve(
  plugin: string,
  spec: ConfigSpec<unknown>,
  homeFile: HarnessConfigFile,
  projectFile: HarnessConfigFile,
  deps: StoreDeps,
): ResolveResult {
  const homeSection = homeFile.plugins?.[plugin];
  const projectSection = projectFile.plugins?.[plugin];
  const merged = mergeLayers(spec.defaults as Record<string, unknown>, homeSection, projectSection);
  const resolution = pickResolution(spec.defaults as Record<string, unknown>, homeSection, projectSection);
  const { value: withEnv, resolution: finalRes } = applyEnvOverrides(
    merged,
    spec.schema as ConfigSchema<unknown> | undefined,
    spec.envVars as Record<string, string> | undefined,
    deps.env,
    resolution,
  );
  if (spec.schema) {
    const r = validate(withEnv, spec.schema as ConfigSchema<unknown>);
    if (!r.ok) {
      deps.log(
        `kaizen-config: validation failed for '${plugin}': ${r.errors.map((e) => `${e.path}: ${e.message}`).join("; ")} — using defaults`,
      );
      return {
        ok: false,
        value: spec.defaults,
        resolution: defaultResolution(spec.defaults as Record<string, unknown>),
        errors: r.errors,
      };
    }
  }
  const taggedRes = tagSecretResolution(withEnv as Record<string, unknown>, finalRes);
  return { ok: true, value: withEnv, resolution: taggedRes };
}

function mergeLayers(
  defaults: Record<string, unknown>,
  home?: Record<string, unknown>,
  project?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...defaults };
  for (const layer of [home, project]) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      const prev = out[k];
      if (isPlainObject(prev) && isPlainObject(v)) {
        out[k] = { ...prev, ...v };
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

function tagSecretResolution(
  merged: Record<string, unknown>,
  resolution: Record<string, ResolutionSource>,
): Record<string, ResolutionSource> {
  const out: Record<string, ResolutionSource> = { ...resolution };
  for (const [k, v] of Object.entries(merged)) {
    if (!isSecretRef(v)) continue;
    const idx = v.$ref.indexOf(":");
    const scheme = idx > 0 ? v.$ref.slice(0, idx) : "unknown";
    out[k] = `secret:${scheme}` as ResolutionSource;
  }
  return out;
}

function pickResolution(
  defaults: Record<string, unknown>,
  home?: Record<string, unknown>,
  project?: Record<string, unknown>,
): Record<string, ResolutionSource> {
  const out: Record<string, ResolutionSource> = {};
  for (const k of Object.keys(defaults)) out[k] = "default";
  if (home) for (const k of Object.keys(home)) out[k] = "home";
  if (project) for (const k of Object.keys(project)) out[k] = "project";
  return out;
}

function defaultResolution(defaults: Record<string, unknown>): Record<string, ResolutionSource> {
  const out: Record<string, ResolutionSource> = {};
  for (const k of Object.keys(defaults)) out[k] = "default";
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
