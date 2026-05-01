import type { CompletionItem } from "../state/store.ts";

export interface CompletionSource {
  id: string;
  trigger: string;
  list(query: string): CompletionItem[] | Promise<CompletionItem[]>;
}

export interface TuiCompletionService {
  register(source: CompletionSource): () => void;
}

export interface CompletionRegistry {
  service: TuiCompletionService;
  query(trigger: string, q: string): Promise<CompletionItem[]>;
}

export interface RegistryOptions { debounceMs?: number; }

interface Pending {
  trigger: string;
  q: string;
  resolve: (items: CompletionItem[]) => void;
}

export function makeCompletionRegistry(opts: RegistryOptions = {}): CompletionRegistry {
  const debounceMs = opts.debounceMs ?? 50;
  const sources = new Map<string, CompletionSource>();
  let token = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Pending | null = null;

  const service: TuiCompletionService = {
    register(source) {
      sources.set(source.id, source);
      return () => { sources.delete(source.id); };
    },
  };

  function fire(): void {
    const job = pending;
    pending = null;
    timer = null;
    if (!job) return;
    const myToken = ++token;

    const matched = [...sources.values()].filter(s => s.trigger === job.trigger);
    Promise.all(matched.map(async (s) => {
      try { return await s.list(job.q); } catch { return [] as CompletionItem[]; }
    })).then((groups) => {
      if (myToken !== token) {
        // A newer query was issued; discard.
        job.resolve([]);
        return;
      }
      const merged = groups.flat();
      merged.sort((a, b) => {
        const wa = a.sortWeight ?? 0;
        const wb = b.sortWeight ?? 0;
        if (wb !== wa) return wb - wa;
        return a.label.localeCompare(b.label);
      });
      job.resolve(merged);
    }).catch(() => job.resolve([]));
  }

  async function query(trigger: string, q: string): Promise<CompletionItem[]> {
    // Coalesce: only the most recent (trigger, q) wins.
    if (pending) pending.resolve([]);
    if (timer) { clearTimeout(timer); timer = null; }

    return new Promise<CompletionItem[]>((resolve) => {
      pending = { trigger, q, resolve };
      if (debounceMs <= 0) {
        fire();
      } else {
        timer = setTimeout(fire, debounceMs);
      }
    });
  }

  return { service, query };
}
