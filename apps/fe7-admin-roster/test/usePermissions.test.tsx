// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { gateway } from "@dub/types";
import { RosterProvider } from "../src/providers/RosterProvider";
import { createMockClient } from "../src/api/mockClient";
import { usePermissions } from "../src/hooks/usePermissions";
import { makeMe } from "./renderWithProviders";

function wrapper(me: gateway.MeResponse | null) {
  const qc = new QueryClient();
  const client = createMockClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <RosterProvider client={client} me={me}>{children}</RosterProvider>
    </QueryClientProvider>
  );
}

describe("usePermissions", () => {
  it("can() reflects effectivePermissions once loaded", () => {
    const { result } = renderHook(() => usePermissions(), { wrapper: wrapper(makeMe(["identity:read"])) });
    expect(result.current.ready).toBe(true);
    expect(result.current.can("identity:read")).toBe(true);
    expect(result.current.can("identity:admin")).toBe(false);
  });

  it("fail-closed while me is null (loading)", () => {
    const { result } = renderHook(() => usePermissions(), { wrapper: wrapper(null) });
    expect(result.current.ready).toBe(false);
    expect(result.current.can("identity:read")).toBe(false);
    expect(result.current.canAll([])).toBe(false);
  });
});
