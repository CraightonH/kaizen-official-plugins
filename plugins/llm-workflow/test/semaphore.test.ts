import { describe, it, expect } from "bun:test";
import { makeSemaphore } from "../semaphore.ts";
import { AgentLifetimeCapError } from "../errors.ts";

describe("semaphore", () => {
  it("enforces concurrent cap", async () => {
    const sem = makeSemaphore({ maxConcurrency: 2, maxLifetimeAgents: 100 });
    let inflight = 0; let peak = 0;
    const run = async () => {
      await sem.acquire();
      inflight++; peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      sem.release();
    };
    await Promise.all([run(), run(), run(), run()]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("counts lifetime acquires across releases", async () => {
    const sem = makeSemaphore({ maxConcurrency: 4, maxLifetimeAgents: 3 });
    await sem.acquire(); sem.release();
    await sem.acquire(); sem.release();
    await sem.acquire(); sem.release();
    await expect(sem.acquire()).rejects.toBeInstanceOf(AgentLifetimeCapError);
  });

  it("release is safe to over-call (drops to zero, never negative)", () => {
    const sem = makeSemaphore({ maxConcurrency: 1, maxLifetimeAgents: 100 });
    sem.release(); // no-op (count already 0)
    expect(sem.inflight()).toBe(0);
  });

  it("reports counters", async () => {
    const sem = makeSemaphore({ maxConcurrency: 4, maxLifetimeAgents: 100 });
    await sem.acquire();
    expect(sem.lifetime()).toBe(1);
    expect(sem.inflight()).toBe(1);
    sem.release();
    expect(sem.inflight()).toBe(0);
  });
});
