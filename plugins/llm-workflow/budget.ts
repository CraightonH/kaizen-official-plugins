import { BudgetExceededError } from "./errors.ts";

export interface BudgetOptions {
  total: number | null;
}

export interface Budget {
  total: number | null;
  spent(): number;
  remaining(): number;
  add(n: number): void;
  assertNotExceeded(): void;
}

export function makeBudget(opts: BudgetOptions): Budget {
  let used = 0;
  return {
    get total() { return opts.total; },
    spent() { return used; },
    remaining() {
      if (opts.total == null) return Infinity;
      return Math.max(0, opts.total - used);
    },
    add(n: number) {
      if (typeof n === "number" && Number.isFinite(n) && n > 0) used += n;
    },
    assertNotExceeded() {
      if (opts.total != null && used >= opts.total) {
        throw new BudgetExceededError(
          `workflow exceeded token budget of ${opts.total} (spent ${used})`,
        );
      }
    },
  };
}
