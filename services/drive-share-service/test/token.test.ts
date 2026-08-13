import { describe, it, expect, vi } from "vitest";
import { CommonErrorCodes } from "@dub/errors";
import { createTokenProvider } from "../src/google/token";

const CREDS = { clientId: "cid", clientSecret: "sec", refreshToken: "rt" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("token provider", () => {
  it("refreshes once and caches until expiry", async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "at-1", expires_in: 3600 }));
    const tp = createTokenProvider({ credentials: CREDS, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now });

    expect(await tp.getAccessToken()).toBe("at-1");
    expect(await tp.getAccessToken()).toBe("at-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1); // cached

    now += 3600 * 1000; // past (expiry - 60s)
    fetchImpl.mockResolvedValueOnce(jsonResponse({ access_token: "at-2", expires_in: 3600 }));
    expect(await tp.getAccessToken()).toBe("at-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("forceRefresh bypasses the cache", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "a", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "b", expires_in: 3600 }));
    const tp = createTokenProvider({ credentials: CREDS, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await tp.getAccessToken()).toBe("a");
    expect(await tp.getAccessToken({ forceRefresh: true })).toBe("b");
  });

  it("maps a non-2xx token response to an upstream error (no secret leak)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400));
    const tp = createTokenProvider({ credentials: CREDS, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(tp.getAccessToken()).rejects.toMatchObject({ code: CommonErrorCodes.UPSTREAM_UNAVAILABLE });
  });
});
