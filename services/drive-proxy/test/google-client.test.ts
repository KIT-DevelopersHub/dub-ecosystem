import { describe, it, expect } from "vitest";
import { isDubError, CommonErrorCodes } from "@dub/errors";
import { createGoogleClient } from "../src/google/client";
import type { TokenProvider } from "../src/google/token";

function fakeToken(): TokenProvider & { forces: boolean[] } {
  const forces: boolean[] = [];
  return {
    async getAccessToken(o) { forces.push(!!o?.forceRefresh); return "tok"; },
    forces,
  };
}

function seq(responses: (() => Response)[]): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[i++];
    if (!r) throw new Error("no more responses");
    return r();
  }) as unknown as typeof fetch;
}

const ok = (body: unknown, status = 200, headers?: Record<string, string>) =>
  () => new Response(JSON.stringify(body), { status, ...(headers ? { headers } : {}) });
const abort = () => () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try { await fn(); throw new Error("expected throw"); }
  catch (e) { expect(isDubError(e)).toBe(true); expect((e as { code: string }).code).toBe(code); }
}

describe("GoogleDriveApi error conversion (§6, test #4)", () => {
  it("gets a file on 200", async () => {
    const client = createGoogleClient({ token: fakeToken(), fetchImpl: seq([ok({ id: "x", name: "N", mimeType: "text/plain" })]) });
    expect((await client.getFile("x")).name).toBe("N");
  });
  it("404 -> NOT_FOUND", async () => {
    const client = createGoogleClient({ token: fakeToken(), fetchImpl: seq([ok({ error: { message: "no" } }, 404)]) });
    await expectCode(() => client.getFile("x"), CommonErrorCodes.NOT_FOUND);
  });
  it("403 -> FORBIDDEN", async () => {
    const client = createGoogleClient({ token: fakeToken(), fetchImpl: seq([ok({ error: { message: "denied" } }, 403)]) });
    await expectCode(() => client.getFile("x"), CommonErrorCodes.FORBIDDEN);
  });
  it("409 -> CONFLICT", async () => {
    const client = createGoogleClient({ token: fakeToken(), fetchImpl: seq([ok({}, 409)]) });
    await expectCode(() => client.getFile("x"), CommonErrorCodes.CONFLICT);
  });
  it("429 -> RATE_LIMITED with Retry-After passthrough", async () => {
    const client = createGoogleClient({ token: fakeToken(), fetchImpl: seq([ok({}, 429, { "retry-after": "42" })]) });
    try { await client.getFile("x"); throw new Error("expected"); }
    catch (e) {
      expect((e as { code: string }).code).toBe(CommonErrorCodes.RATE_LIMITED);
      expect((e as { details: { retryAfterSec: number } }).details.retryAfterSec).toBe(42);
    }
  });
  it("500 -> UPSTREAM_UNAVAILABLE", async () => {
    const client = createGoogleClient({ token: fakeToken(), fetchImpl: seq([ok({}, 500)]) });
    await expectCode(() => client.getFile("x"), CommonErrorCodes.UPSTREAM_UNAVAILABLE);
  });
  it("network abort -> UPSTREAM_TIMEOUT", async () => {
    const client = createGoogleClient({ token: fakeToken(), fetchImpl: seq([abort()]) });
    await expectCode(() => client.getFile("x"), CommonErrorCodes.UPSTREAM_TIMEOUT);
  });
});

describe("401 handling", () => {
  it("forces one token refresh and retries on 401", async () => {
    const token = fakeToken();
    const client = createGoogleClient({
      token,
      fetchImpl: seq([ok({}, 401), ok({ id: "x", name: "N", mimeType: "text/plain" })]),
    });
    const f = await client.getFile("x");
    expect(f.name).toBe("N");
    expect(token.forces).toEqual([false, true]); // 2nd attempt forced a refresh
  });
  it("maps persistent 401 to UPSTREAM_UNAVAILABLE", async () => {
    const client = createGoogleClient({ token: fakeToken(), fetchImpl: seq([ok({}, 401), ok({}, 401)]) });
    await expectCode(() => client.getFile("x"), CommonErrorCodes.UPSTREAM_UNAVAILABLE);
  });
});

describe("sheets append response shape", () => {
  it("reads updatedRange/updatedRows from the append `updates` envelope", async () => {
    const client = createGoogleClient({
      token: fakeToken(),
      fetchImpl: seq([ok({ updates: { updatedRange: "S!A5:B5", updatedRows: 1 } })]),
    });
    const r = await client.appendSheetValues("s", "A1:B2", [["a", "b"]]);
    expect(r).toEqual({ updatedRange: "S!A5:B5", updatedRows: 1 });
  });
});
