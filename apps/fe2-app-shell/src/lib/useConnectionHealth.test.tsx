import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useConnectionHealth } from "./useConnectionHealth.ts";

const BASE = "https://gw.example.dev";

function setOnLine(value: boolean): void {
  Object.defineProperty(navigator, "onLine", { value, configurable: true });
}

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })) as unknown as typeof fetch;
}
function failFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new TypeError("network");
  }) as unknown as typeof fetch;
}

afterEach(() => {
  setOnLine(true);
  vi.restoreAllMocks();
});

describe("useConnectionHealth", () => {
  it("reports online when navigator is online and /healthz answers ok", async () => {
    setOnLine(true);
    const fetchImpl = okFetch();
    const { result } = renderHook(() => useConnectionHealth({ baseUrl: BASE, fetchImpl }));
    await waitFor(() => expect(result.current).toBe("online"));
    expect(fetchImpl).toHaveBeenCalledWith(`${BASE}/healthz`, expect.objectContaining({ method: "GET" }));
  });

  it("reports unreachable when navigator is online but /healthz fails", async () => {
    setOnLine(true);
    const { result } = renderHook(() => useConnectionHealth({ baseUrl: BASE, fetchImpl: failFetch() }));
    await waitFor(() => expect(result.current).toBe("unreachable"));
  });

  it("reports unreachable when /healthz returns a non-ok status", async () => {
    setOnLine(true);
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 503 })) as unknown as typeof fetch;
    const { result } = renderHook(() => useConnectionHealth({ baseUrl: BASE, fetchImpl }));
    await waitFor(() => expect(result.current).toBe("unreachable"));
  });

  it("reports offline immediately when navigator is offline (no probe needed)", async () => {
    setOnLine(false);
    const fetchImpl = okFetch();
    const { result } = renderHook(() => useConnectionHealth({ baseUrl: BASE, fetchImpl }));
    await waitFor(() => expect(result.current).toBe("offline"));
    // While offline the hook must not fire a pointless (misleading) probe.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("switches offline -> online and re-probes when the network returns", async () => {
    setOnLine(false);
    const fetchImpl = okFetch();
    const { result } = renderHook(() => useConnectionHealth({ baseUrl: BASE, fetchImpl }));
    await waitFor(() => expect(result.current).toBe("offline"));

    setOnLine(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(result.current).toBe("online"));
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("switches online -> offline when the offline event fires", async () => {
    setOnLine(true);
    const { result } = renderHook(() => useConnectionHealth({ baseUrl: BASE, fetchImpl: okFetch() }));
    await waitFor(() => expect(result.current).toBe("online"));

    setOnLine(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    await waitFor(() => expect(result.current).toBe("offline"));
  });

  it("never probes when probing is disabled, but STILL reports offline (backend-independent)", async () => {
    setOnLine(false);
    const fetchImpl = okFetch();
    const { result } = renderHook(() =>
      useConnectionHealth({ baseUrl: BASE, probeEnabled: false, fetchImpl }),
    );
    // Offline detection is universal (works in demo/mock too): the banner must show.
    await waitFor(() => expect(result.current).toBe("offline"));
    // But with probing off, no /healthz request is ever made (no false "unreachable").
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stays online (no false unreachable) when probing is disabled and network is up", async () => {
    setOnLine(true);
    const fetchImpl = failFetch();
    const { result } = renderHook(() =>
      useConnectionHealth({ baseUrl: BASE, probeEnabled: false, fetchImpl }),
    );
    await waitFor(() => expect(result.current).toBe("online"));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
