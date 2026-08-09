import { describe, it, expect } from "vitest";
import { isDubError, CommonErrorCodes } from "@dub/errors";
import { createTokenProvider } from "../src/google/token";
import { TOKEN_KEY } from "../src/cache";
import { memCache } from "./helpers";

const creds = { clientId: "cid", clientSecret: "csecret", refreshToken: "rtok" };

function fetchOnce(body: unknown, status = 200): { fn: typeof fetch; count: () => number } {
  let n = 0;
  const fn = (async () => { n++; return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
  return { fn, count: () => n };
}

describe("TokenProvider", () => {
  it("refreshes once then serves from cache", async () => {
    const cache = memCache();
    const { fn, count } = fetchOnce({ access_token: "AT", expires_in: 3600 });
    const tp = createTokenProvider({ cache, credentials: creds, fetchImpl: fn });
    expect(await tp.getAccessToken()).toBe("AT");
    expect(await tp.getAccessToken()).toBe("AT");
    expect(count()).toBe(1); // second call hit the cache
    expect(await cache.get<{ accessToken: string }>(TOKEN_KEY)).toEqual({ accessToken: "AT" });
  });

  it("forceRefresh bypasses the cache", async () => {
    const cache = memCache();
    let n = 0;
    const fn = (async () => { n++; return new Response(JSON.stringify({ access_token: `AT${n}`, expires_in: 3600 }), { status: 200 }); }) as unknown as typeof fetch;
    const tp = createTokenProvider({ cache, credentials: creds, fetchImpl: fn });
    expect(await tp.getAccessToken()).toBe("AT1");
    expect(await tp.getAccessToken({ forceRefresh: true })).toBe("AT2");
    expect(n).toBe(2);
  });

  it("maps a non-2xx refresh to UPSTREAM_UNAVAILABLE (no secret leak)", async () => {
    const cache = memCache();
    const { fn } = fetchOnce({ error: "invalid_grant" }, 400);
    const tp = createTokenProvider({ cache, credentials: creds, fetchImpl: fn });
    try { await tp.getAccessToken(); throw new Error("expected throw"); }
    catch (e) {
      expect(isDubError(e)).toBe(true);
      expect((e as { code: string }).code).toBe(CommonErrorCodes.UPSTREAM_UNAVAILABLE);
      expect((e as Error).message).not.toContain("csecret");
      expect((e as Error).message).not.toContain("rtok");
    }
  });

  it("maps a network failure to UPSTREAM_UNAVAILABLE", async () => {
    const cache = memCache();
    const fn = (async () => { throw new Error("net down"); }) as unknown as typeof fetch;
    const tp = createTokenProvider({ cache, credentials: creds, fetchImpl: fn });
    try { await tp.getAccessToken(); throw new Error("expected throw"); }
    catch (e) { expect((e as { code: string }).code).toBe(CommonErrorCodes.UPSTREAM_UNAVAILABLE); }
  });
});
