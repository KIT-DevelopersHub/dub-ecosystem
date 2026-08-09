import { describe, it, expect } from "vitest";
import { runOptimistic, type StateBox } from "./optimistic";

function box<T>(initial: T): StateBox<T> & { value: T } {
  const b = {
    value: initial,
    get: () => b.value,
    set: (n: T) => {
      b.value = n;
    },
  };
  return b;
}

describe("runOptimistic", () => {
  it("applies optimistically then reconciles on success", async () => {
    const b = box({ n: 0 });
    const seen: number[] = [];
    const result = await runOptimistic(
      b,
      {
        apply: (s) => {
          seen.push(s.n);
          return { n: 1 };
        },
        mutate: async () => 42,
        reconcile: (_s, _v, r) => ({ n: r }),
      },
      undefined,
    );
    expect(result).toBe(42);
    expect(b.value).toEqual({ n: 42 });
  });

  it("rolls back to the snapshot on error and rethrows", async () => {
    const b = box({ n: 5 });
    await expect(
      runOptimistic(
        b,
        {
          apply: () => ({ n: 999 }),
          mutate: async () => {
            throw new Error("boom");
          },
        },
        undefined,
      ),
    ).rejects.toThrow("boom");
    expect(b.value).toEqual({ n: 5 });
  });

  it("uses a custom rollback (e.g. mark failed) when provided", async () => {
    const b = box({ status: "idle" });
    await expect(
      runOptimistic(
        b,
        {
          apply: () => ({ status: "sending" }),
          mutate: async () => {
            throw new Error("net");
          },
          rollback: () => ({ status: "failed" }),
        },
        undefined,
      ),
    ).rejects.toThrow("net");
    expect(b.value).toEqual({ status: "failed" });
  });
});
