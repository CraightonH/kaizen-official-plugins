import type {
  RegisteredSection,
  SystemPromptSection,
  SystemPromptService,
} from "./public";

interface RegistryEntry {
  section: SystemPromptSection;
  registeredAtGen: number;
  registrationOrder: number;
  disabled: boolean;
  removed: boolean;
}

export interface CreateRegistryOptions {
  emit: (event: string, payload: unknown) => void | Promise<void>;
}

export interface SystemPromptServiceImpl extends SystemPromptService {
  disable(id: string): void;
  enable(id: string): void;
  has(id: string): boolean;
  renderSection(id: string): Promise<string | undefined>;
}

export function createRegistry(opts: CreateRegistryOptions): SystemPromptServiceImpl {
  const map = new Map<string, RegistryEntry>();
  let generation = 0;
  let order = 0;
  let cachedAssembly: string | null = null;
  let cachedAtGen = -1;

  function bump(): void {
    generation += 1;
    cachedAssembly = null;
    void opts.emit("prompt:rebuilt", { generation });
  }

  function register(section: SystemPromptSection): RegisteredSection {
    const existing = map.get(section.id);
    if (existing && !existing.removed) {
      throw new Error(
        `prompt:system: section "${section.id}" already registered; unregister via the prior handle before re-registering`,
      );
    }
    const entry: RegistryEntry = {
      section,
      registeredAtGen: generation + 1,
      registrationOrder: order++,
      disabled: false,
      removed: false,
    };
    map.set(section.id, entry);
    bump();

    const handle: RegisteredSection = {
      unregister(): void {
        if (entry.removed) return;
        entry.removed = true;
        if (map.get(section.id) === entry) map.delete(section.id);
        bump();
      },
      bumpGeneration(): void {
        if (entry.removed) return;
        bump();
      },
    };
    return handle;
  }

  function disable(id: string): void {
    const e = map.get(id);
    if (!e || e.disabled) return;
    e.disabled = true;
    bump();
  }

  function enable(id: string): void {
    const e = map.get(id);
    if (!e || !e.disabled) return;
    e.disabled = false;
    bump();
  }

  function list(): ReadonlyArray<{ id: string; priority: number; title?: string }> {
    return Array.from(map.values()).map((e) => ({
      id: e.section.id,
      priority: e.section.priority,
      ...(e.section.title !== undefined ? { title: e.section.title } : {}),
    }));
  }

  async function assemble(): Promise<string> {
    if (cachedAssembly !== null && cachedAtGen === generation) return cachedAssembly;

    const ordered = Array.from(map.values())
      .filter((e) => !e.removed)
      .sort((a, b) => {
        if (a.section.priority !== b.section.priority) {
          return a.section.priority - b.section.priority;
        }
        return a.registrationOrder - b.registrationOrder;
      });

    const parts: string[] = [];
    for (const e of ordered) {
      if (e.disabled) continue;
      let body: string;
      try {
        const r = e.section.render();
        body = r instanceof Promise ? await r : r;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        body = `<!-- prompt:system render error in "${e.section.id}": ${msg} -->`;
      }
      if (!body || body.length === 0) continue;
      const heading = e.section.title ? `## ${e.section.title}\n` : "";
      parts.push(`${heading}${body}`);
    }

    cachedAssembly = parts.join("\n\n");
    cachedAtGen = generation;
    return cachedAssembly;
  }

  function has(id: string): boolean {
    const e = map.get(id);
    return Boolean(e && !e.removed);
  }

  async function renderSection(id: string): Promise<string | undefined> {
    const e = map.get(id);
    if (!e || e.removed || e.disabled) return undefined;
    try {
      const r = e.section.render();
      return r instanceof Promise ? await r : r;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `<!-- render error: ${msg} -->`;
    }
  }

  return {
    register,
    assemble,
    list,
    generation: () => generation,
    disable,
    enable,
    has,
    renderSection,
  };
}
