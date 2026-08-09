import { describe, it, expect } from "vitest";
import { backoffDelay, BACKOFF_BASE_MS, BACKOFF_MAX_MS } from "./client";

describe("backoffDelay", () => {
  it("grows exponentially from the base (no jitter)", () => {
    const noJitter = () => 0.5; // 1 + (0.5*0.4 - 0.2) = 1.0
    expect(backoffDelay(0, noJitter)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelay(1, noJitter)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffDelay(2, noJitter)).toBe(BACKOFF_BASE_MS * 4);
  });

  it("caps at the max", () => {
    const noJitter = () => 0.5;
    expect(backoffDelay(20, noJitter)).toBe(BACKOFF_MAX_MS);
  });

  it("stays within the ±20% jitter band", () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
      expect(backoffDelay(attempt, () => 0)).toBeGreaterThanOrEqual(Math.round(base * 0.8) - 1);
      expect(backoffDelay(attempt, () => 1)).toBeLessThanOrEqual(Math.round(base * 1.2) + 1);
    }
  });
});
