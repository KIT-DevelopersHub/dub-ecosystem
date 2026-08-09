import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import { createOptimisticMutation } from "../src/hooks/useOptimisticMutation";
import { newQueryClient, resetAuth } from "./util";
import { DubError } from "@dub/errors";
import { EventErrorCodes } from "../src/lib/errorMap";

beforeEach(() => resetAuth());
afterEach(() => resetAuth());

interface Cache {
  value: string;
}
const KEY = ["events", "detail", "evt_1"];

function wrapper(qc = newQueryClient()) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    );
  };
}

describe("createOptimisticMutation (test observation #5)", () => {
  it("applies optimistic update then rolls back on failure", async () => {
    const qc = newQueryClient();
    qc.setQueryData<Cache>(KEY, { value: "original" });
    const seen: string[] = [];
    // Observe every cache transition for KEY so we can assert optimistic -> rollback
    // deterministically instead of racing waitFor against the reject microtask.
    const unsub = qc.getQueryCache().subscribe(() => {
      const v = qc.getQueryData<Cache>(KEY)?.value;
      if (v && seen[seen.length - 1] !== v) seen.push(v);
    });

    const { result } = renderHook(
      () =>
        createOptimisticMutation<Cache, { next: string }, Cache>({
          mutationFn: async () => {
            throw new DubError("INTERNAL", "boom", { status: 500 });
          },
          queryKey: KEY,
          optimisticUpdate: (_prev, vars) => ({ value: vars.next }),
        }),
      { wrapper: wrapper(qc) },
    );

    act(() => {
      result.current.mutate({ next: "optimistic" });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    unsub();
    // optimistic value was applied at some point, and the final value is rolled back
    expect(seen).toContain("optimistic");
    expect(qc.getQueryData<Cache>(KEY)?.value).toBe("original");
  });

  it("rolls back and refetches on version conflict", async () => {
    const qc = newQueryClient();
    qc.setQueryData<Cache>(KEY, { value: "v1" });

    const { result } = renderHook(
      () =>
        createOptimisticMutation<Cache, { next: string }, Cache>({
          mutationFn: async () => {
            throw new DubError(EventErrorCodes.VERSION_CONFLICT, "conflict", { status: 409 });
          },
          queryKey: KEY,
          optimisticUpdate: (_prev, vars) => ({ value: vars.next }),
        }),
      { wrapper: wrapper(qc) },
    );

    act(() => {
      result.current.mutate({ next: "v2" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(qc.getQueryData<Cache>(KEY)?.value).toBe("v1"); // rolled back
  });

  it("succeeds and commits optimistic value", async () => {
    const qc = newQueryClient();
    qc.setQueryData<Cache>(KEY, { value: "start" });

    const { result } = renderHook(
      () =>
        createOptimisticMutation<Cache, { next: string }, Cache>({
          mutationFn: async () => ({ value: "committed" }),
          queryKey: KEY,
          optimisticUpdate: (_prev, vars) => ({ value: vars.next }),
        }),
      { wrapper: wrapper(qc) },
    );

    act(() => {
      result.current.mutate({ next: "pending" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});
