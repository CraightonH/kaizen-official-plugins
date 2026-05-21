import type { CompletionItem, CompletionSource, UiCompletionService } from "llm-contracts/public";
export type { CompletionItem, CompletionSource, UiCompletionService } from "llm-contracts/public";

export interface CompletionRegistry {
  service: UiCompletionService;
  query(trigger: string, q: string): Promise<CompletionItem[]>;
  queryBySource(sourceId: string, q: string, ctx?: { line: string; cursor: number }): Promise<CompletionItem[]>;
}

export interface RegistryOptions { debounceMs?: number; }

interface Pending {
  trigger: string; // sentinel "__by-id" for queryBySource
  q: string;
  resolve: (items: CompletionItem[]) => void;
  sourceId?: string;
  qctx?: { line: string; cursor: number };
}

export function makeCompletionRegistry(opts: RegistryOptions = {}): CompletionRegistry {
  const debounceMs = opts.debounceMs ?? 50;
  const sources = new Map<string, CompletionSource>();
  let token = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Pending | null = null;

  const service: UiCompletionService = {
    register(source) {
      sources.set(source.id, source);
      return () => {
        if (sources.get(source.id) === source) sources.delete(source.id);
      };
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

  function fireById(): void {
    const job = pending;
    pending = null;
    timer = null;
    if (!job || !job.sourceId) return;
    const myToken = ++token;
    const src = sources.get(job.sourceId);
    if (!src) { job.resolve([]); return; }
    Promise.resolve()
      .then(() => src.list(job.q, job.qctx))
      .catch(() => [] as CompletionItem[])
      .then((items) => {
        if (myToken !== token) { job.resolve([]); return; }
        const arr = Array.isArray(items) ? items : [];
        arr.sort((a, b) => {
          const wa = a.sortWeight ?? 0; const wb = b.sortWeight ?? 0;
          if (wb !== wa) return wb - wa;
          return a.label.localeCompare(b.label);
        });
        job.resolve(arr);
      });
  }

  async function queryBySource(sourceId: string, q: string, qctx?: { line: string; cursor: number }): Promise<CompletionItem[]> {
    if (pending) pending.resolve([]);
    if (timer) { clearTimeout(timer); timer = null; }
    return new Promise<CompletionItem[]>((resolve) => {
      pending = { trigger: "__by-id", q, resolve, sourceId, qctx };
      if (debounceMs <= 0) fireById();
      else timer = setTimeout(fireById, debounceMs);
    });
  }

  return { service, query, queryBySource };
}
