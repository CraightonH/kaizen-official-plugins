import { describe, it, expect } from "bun:test";
import { makeBudget } from "../budget.ts";
import { BudgetExceededError } from "../errors.ts";

describe("budget", () => {
  it("starts at 0, accumulates from add()", () => {
    const b = makeBudget({ total: null });
    expect(b.spent()).toBe(0);
    b.add(10);
    b.add(15);
    expect(b.spent()).toBe(25);
  });

  it("remaining returns Infinity when total is null", () => {
    const b = makeBudget({ total: null });
    expect(b.remaining()).toBe(Infinity);
    b.add(50);
    expect(b.remaining()).toBe(Infinity);
  });

  it("remaining returns max(0, total - spent)", () => {
    const b = makeBudget({ total: 100 });
    expect(b.remaining()).toBe(100);
    b.add(30);
    expect(b.remaining()).toBe(70);
    b.add(80);
    expect(b.remaining()).toBe(0);
  });

  it("assertNotExceeded throws BudgetExceededError once at the cap", () => {
    const b = makeBudget({ total: 100 });
    b.add(100);
    expect(() => b.assertNotExceeded()).toThrow(BudgetExceededError);
  });

  it("assertNotExceeded is a no-op when total is null", () => {
    const b = makeBudget({ total: null });
    b.add(999999);
    expect(() => b.assertNotExceeded()).not.toThrow();
  });
});
