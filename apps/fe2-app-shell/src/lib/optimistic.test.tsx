import { describe, it, expect, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createOptimisticMutation } from "./optimistic.tsx";
import { ApiError } from "./api-client.tsx";

const KEY = ["events", "list"] as const;

function seed(qc: QueryClient, value: string[]): void {
  qc.setQueryData(KEY, value);
}

describe("createOptimisticMutation", () => {
  it("applies optimistic cache update then invalidates on success", async () => {
    const qc = new QueryClient();
    seed(qc, ["a"]);
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const opts = createOptimisticMutation<string[], string, string[]>(qc, {
      mutationFn: async (v) => [...(qc.getQueryData<string[]>(KEY) ?? []), v],
      cacheKey: KEY,
      applyOptimistic: (prev, v) => [...prev, v],
    });

    const onMutate = opts.onMutate as (v: string) => Promise<{ previous: string[] | undefined }>;
    const onSettled = opts.onSettled as (...a: unknown[]) => void;
    const ctx = await onMutate("b");
    expect(qc.getQueryData<string[]>(KEY)).toEqual(["a", "b"]); // optimistic apply
    await (opts.mutationFn as (v: string) => Promise<string[]>)("b");
    onSettled(undefined, null, "b", ctx);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
  });

  it("rolls back to the snapshot and fires the error toast on failure", async () => {
    const qc = new QueryClient();
    seed(qc, ["a"]);
    const onErrorToast = vi.fn();
    const opts = createOptimisticMutation<string[], string, string[]>(qc, {
      mutationFn: async () => {
        throw new ApiError(409, { error: { code: "CONFLICT", message: "x", retryable: false } });
      },
      cacheKey: KEY,
      applyOptimistic: (prev, v) => [...prev, v],
      onErrorToast,
    });

    const onMutate = opts.onMutate as (v: string) => Promise<{ previous: string[] | undefined }>;
    const onError = opts.onError as (...a: unknown[]) => void;
    const ctx = await onMutate("b");
    expect(qc.getQueryData<string[]>(KEY)).toEqual(["a", "b"]);
    const err = new ApiError(409, { error: { code: "CONFLICT", message: "x", retryable: false } });
    onError(err, "b", ctx);
    expect(qc.getQueryData<string[]>(KEY)).toEqual(["a"]); // ロールバック
    expect(onErrorToast).toHaveBeenCalledWith(err);
  });
});
