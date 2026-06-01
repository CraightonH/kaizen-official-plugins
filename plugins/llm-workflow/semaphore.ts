import { AgentLifetimeCapError } from "./errors.ts";

export interface SemaphoreOptions {
  maxConcurrency: number;
  maxLifetimeAgents: number;
}

export interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
  inflight(): number;
  lifetime(): number;
}

export function makeSemaphore(opts: SemaphoreOptions): Semaphore {
  let inflight = 0;
  let lifetime = 0;
  const waiters: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (lifetime >= opts.maxLifetimeAgents) {
      return Promise.reject(new AgentLifetimeCapError(
        `workflow exceeded lifetime agent cap of ${opts.maxLifetimeAgents}`,
      ));
    }
    lifetime++;
    if (inflight < opts.maxConcurrency) {
      inflight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => { inflight++; resolve(); });
    });
  }

  function release(): void {
    if (inflight === 0 && waiters.length === 0) return;
    if (inflight > 0) inflight--;
    const next = waiters.shift();
    if (next) next();
  }

  return {
    acquire,
    release,
    inflight: () => inflight,
    lifetime: () => lifetime,
  };
}

/** Resolve max-concurrency cap from config: explicit value, or auto = min(16, max(1, cpus - 2)). */
export function resolveMaxConcurrency(cfg: number | null, cpuCount: number): number {
  if (cfg !== null && cfg > 0) return cfg;
  return Math.min(16, Math.max(1, cpuCount - 2));
}
