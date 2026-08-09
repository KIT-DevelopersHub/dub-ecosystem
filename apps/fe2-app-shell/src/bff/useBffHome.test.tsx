import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { gateway } from "@dub/types";
import type { ApiClient } from "../lib/api-client.tsx";
import { useBffHome } from "./useBffHome.tsx";

const HOME: gateway.BffHomeResponse = {
  upcomingEvents: [{ id: "evt_1", title: "Conf", phase: "planning", startsAt: null }],
  unreadCount: 3,
  partialErrors: [{ source: "notification", code: "UPSTREAM_TIMEOUT" }],
};

function makeApi(home: () => Promise<gateway.BffHomeResponse>): ApiClient {
  return { bff: { home } } as unknown as ApiClient;
}

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useBffHome", () => {
  it("returns data and resolves per-source partial errors", async () => {
    const { result } = renderHook(() => useBffHome(makeApi(() => Promise.resolve(HOME))), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.unreadCount).toBe(3);
    expect(result.current.errorFor("notification")?.code).toBe("UPSTREAM_TIMEOUT");
    expect(result.current.errorFor("event-service")).toBeUndefined();
  });
});
