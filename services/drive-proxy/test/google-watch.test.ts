import { describe, it, expect } from "vitest";
import { isDubError, CommonErrorCodes } from "@dub/errors";
import { createGoogleClient } from "../src/google/client";
import type { TokenProvider } from "../src/google/token";

function fakeToken(): TokenProvider {
  return { async getAccessToken() { return "tok"; } };
}

// Records the request(s) the client issues so we can assert the exact files.watch /
// channels.stop wire shape, then replays canned responses in order.
function recorder(responses: (() => Response)[]): { fetch: typeof globalThis.fetch; reqs: { url: string; init: RequestInit }[] } {
  const reqs: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    reqs.push({ url: String(url), init: init ?? {} });
    const r = responses[i++];
    if (!r) throw new Error("no more responses");
    return r();
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, reqs };
}

const res = (body: unknown, status = 200, headers?: Record<string, string>) =>
  () => new Response(status === 204 ? null : JSON.stringify(body), { status, ...(headers ? { headers } : {}) });

describe("GoogleDriveApi.watchFile (files.watch — channel-token issuance)", () => {
  it("POSTs id/type/address/token(+expiration) and maps the channel response", async () => {
    const rec = recorder([res({ id: "chan-123", resourceId: "RID-9", resourceUri: "https://uri", expiration: "1700000000000" })]);
    const client = createGoogleClient({ token: fakeToken(), fetchImpl: rec.fetch });
    const out = await client.watchFile({
      fileId: "folder_1",
      channelId: "chan-123",
      address: "https://ingest.example/webhooks/google-drive",
      token: "SHARED-SECRET",
      expirationMs: 1700000000000,
    });

    expect(out).toEqual({
      channelId: "chan-123",
      resourceId: "RID-9",
      resourceUri: "https://uri",
      expiration: new Date(1700000000000).toISOString(),
    });

    const req = rec.reqs[0]!;
    expect(req.init.method).toBe("POST");
    expect(req.url).toContain("/drive/v3/files/folder_1/watch");
    const body = JSON.parse(String(req.init.body));
    expect(body).toEqual({
      id: "chan-123",
      type: "web_hook",
      address: "https://ingest.example/webhooks/google-drive",
      token: "SHARED-SECRET", // <-- the value webhook-ingest verifies as X-Goog-Channel-Token
      expiration: "1700000000000",
    });
  });

  it("omits expiration when no ttl is given and tolerates a missing resourceUri/expiration", async () => {
    const rec = recorder([res({ id: "chan-x", resourceId: "RID-x" })]);
    const client = createGoogleClient({ token: fakeToken(), fetchImpl: rec.fetch });
    const out = await client.watchFile({ fileId: "f", channelId: "chan-x", address: "https://cb", token: "s" });
    expect(out).toEqual({ channelId: "chan-x", resourceId: "RID-x", resourceUri: null, expiration: null });
    expect(JSON.parse(String(rec.reqs[0]!.init.body))).not.toHaveProperty("expiration");
  });

  it("treats a 2xx without resourceId as upstream failure (cannot ever be stopped)", async () => {
    const rec = recorder([res({ id: "chan-x" })]);
    const client = createGoogleClient({ token: fakeToken(), fetchImpl: rec.fetch });
    await expect(client.watchFile({ fileId: "f", channelId: "c", address: "https://cb", token: "s" })).rejects.toMatchObject({
      code: CommonErrorCodes.UPSTREAM_UNAVAILABLE,
    });
  });

  it("maps a 404 to NOT_FOUND via the §6 error table", async () => {
    const rec = recorder([res({ error: { message: "no" } }, 404)]);
    const client = createGoogleClient({ token: fakeToken(), fetchImpl: rec.fetch });
    try {
      await client.watchFile({ fileId: "f", channelId: "c", address: "https://cb", token: "s" });
      throw new Error("expected throw");
    } catch (e) {
      expect(isDubError(e)).toBe(true);
      expect((e as { code: string }).code).toBe(CommonErrorCodes.NOT_FOUND);
    }
  });
});

describe("GoogleDriveApi.stopChannel (channels.stop)", () => {
  it("POSTs id+resourceId and succeeds on 204", async () => {
    const rec = recorder([res(null, 204)]);
    const client = createGoogleClient({ token: fakeToken(), fetchImpl: rec.fetch });
    await client.stopChannel("chan-1", "RID-1");
    const req = rec.reqs[0]!;
    expect(req.url).toContain("/drive/v3/channels/stop");
    expect(JSON.parse(String(req.init.body))).toEqual({ id: "chan-1", resourceId: "RID-1" });
  });

  it("tolerates a 404 (channel already gone) as an idempotent stop", async () => {
    const rec = recorder([res({ error: { message: "gone" } }, 404)]);
    const client = createGoogleClient({ token: fakeToken(), fetchImpl: rec.fetch });
    await expect(client.stopChannel("chan-1", "RID-1")).resolves.toBeUndefined();
  });

  it("maps a 500 to UPSTREAM_UNAVAILABLE", async () => {
    const rec = recorder([res({}, 500)]);
    const client = createGoogleClient({ token: fakeToken(), fetchImpl: rec.fetch });
    await expect(client.stopChannel("c", "r")).rejects.toMatchObject({ code: CommonErrorCodes.UPSTREAM_UNAVAILABLE });
  });
});
