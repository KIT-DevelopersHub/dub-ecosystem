// Navigation contract: the shim must be reachable from the package's PUBLIC entry
// (src/index.ts) so FE2 can back it with its router WITHOUT a deep import, and the
// fail-soft fallback must return safe no-ops when no provider is mounted. This
// locks the integration seam described in src/contracts/navigation.tsx.
import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import * as pkg from "../src/index";
import {
  NavigationProvider,
  useNavigation,
  useNavigate,
  useRouteParams,
  type NavigationApi,
} from "../src/index";

describe("navigation contract is part of the public surface (#integration)", () => {
  it("re-exports the provider + hooks from the package entry (FE2 needs no deep import)", () => {
    expect(typeof pkg.NavigationProvider).toBe("function");
    expect(typeof pkg.useNavigation).toBe("function");
    expect(typeof pkg.useNavigate).toBe("function");
    expect(typeof pkg.useRouteParams).toBe("function");
  });

  it("fails soft to no-op defaults when no provider is mounted (isolated renders don't throw)", () => {
    const { result } = renderHook(() => useNavigation());
    expect(result.current.params).toEqual({});
    expect(result.current.search).toBe("");
    // navigate / setSearch are callable no-ops, not undefined.
    expect(() => result.current.navigate("/events/evt_1")).not.toThrow();
    expect(() => result.current.setSearch("phase=open")).not.toThrow();
  });

  it("NavigationProvider (from the entry) backs the fallback with the injected router", () => {
    const navigate = vi.fn();
    const setSearch = vi.fn();
    const value: NavigationApi = {
      navigate,
      params: { eventId: "evt_1", actionId: "act_2" },
      search: "phase=open&archived=1",
      setSearch,
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NavigationProvider value={value}>{children}</NavigationProvider>
    );

    const nav = renderHook(() => useNavigation(), { wrapper }).result.current;
    expect(nav.params).toEqual({ eventId: "evt_1", actionId: "act_2" });
    expect(nav.search).toBe("phase=open&archived=1");

    const doNavigate = renderHook(() => useNavigate(), { wrapper }).result.current;
    doNavigate("/events/evt_1/settings");
    expect(navigate).toHaveBeenCalledWith("/events/evt_1/settings");

    const params = renderHook(() => useRouteParams(), { wrapper }).result.current;
    expect(params.eventId).toBe("evt_1");
  });
});
