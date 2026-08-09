import { describe, it, expect } from "vitest";
import { generateIdempotencyKey, isValidUlid } from "../src/lib/idempotency";

describe("generateIdempotencyKey", () => {
  it("produces a 26-char Crockford ULID", () => {
    const k = generateIdempotencyKey();
    expect(k).toHaveLength(26);
    expect(isValidUlid(k)).toBe(true);
  });

  it("is unique across calls", () => {
    const set = new Set(Array.from({ length: 500 }, () => generateIdempotencyKey()));
    expect(set.size).toBe(500);
  });

  it("is time-sortable: later timestamps sort after earlier", () => {
    const a = generateIdempotencyKey(1000);
    const b = generateIdempotencyKey(2000);
    expect(a < b).toBe(true);
  });

  it("rejects malformed ULIDs", () => {
    expect(isValidUlid("short")).toBe(false);
    expect(isValidUlid("i".repeat(26))).toBe(false); // lowercase / illegal chars
  });
});
