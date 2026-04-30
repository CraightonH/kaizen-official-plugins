import { describe, it, expect } from "bun:test";
import { classifyError, computeBackoff, sleep } from "../retry.ts";
import { DEFAULT_CONFIG } from "../config.ts";

describe("classifyError", () => {
  it("network errors retryable", () => {
    expect(classifyError({ kind: "network" })).toEqual({ retryable: true });
  });
  it("connect timeout retryable", () => {
    expect(classifyError({ kind: "connect-timeout" })).toEqual({ retryable: true });
  });
  it("request timeout (mid-stream) NOT retryable", () => {
    expect(classifyError({ kind: "request-timeout" })).toEqual({ retryable: false });
  });
  it("4xx not retryable", () => {
    expect(classifyError({ kind: "http", status: 400 })).toEqual({ retryable: false });
    expect(classifyError({ kind: "http", status: 401 })).toEqual({ retryable: false });
  });
  it("429 retryable, surfaces retryAfterMs", () => {
    expect(classifyError({ kind: "http", status: 429, retryAfterMs: 2000 })).toEqual({ retryable: true, retryAfterMs: 2000 });
  });
  it("5xx retryable", () => {
    expect(classifyError({ kind: "http", status: 503 })).toEqual({ retryable: true });
  });
  it("malformed sse not retryable", () => {
    expect(classifyError({ kind: "malformed" })).toEqual({ retryable: false });
  });
  it("aborted not retryable", () => {
    expect(classifyError({ kind: "aborted" })).toEqual({ retryable: false });
  });
});

describe("computeBackoff", () => {
  it("exponential without jitter", () => {
    const cfg = { ...DEFAULT_CONFIG.retry, jitter: "none" as const };
    expect(computeBackoff(1, cfg)).toBe(500);
    expect(computeBackoff(2, cfg)).toBe(1000);
    expect(computeBackoff(3, cfg)).toBe(2000);
  });
  it("caps at maxDelayMs", () => {
    const cfg = { ...DEFAULT_CONFIG.retry, jitter: "none" as const };
    expect(computeBackoff(99, cfg)).toBe(cfg.maxDelayMs);
  });
  it("full jitter is in [0, computed]", () => {
    const cfg = { ...DEFAULT_CONFIG.retry, jitter: "full" as const };
    for (let i = 0; i < 100; i++) {
      const v = computeBackoff(2, cfg);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1000);
    }
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    const t0 = Date.now();
    await sleep(20, new AbortController().signal);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });
  it("rejects with 'aborted' if signal already aborted", async () => {
    const ac = new AbortController(); ac.abort();
    await expect(sleep(50, ac.signal)).rejects.toThrow("aborted");
  });
  it("rejects when signal fires mid-sleep", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    await expect(sleep(500, ac.signal)).rejects.toThrow("aborted");
  });
});
