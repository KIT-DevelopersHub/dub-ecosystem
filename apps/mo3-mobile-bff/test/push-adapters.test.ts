// Adapter-level tests: real APNs/FCM wire logic with an injected fetch (+ injected
// JWT signer / access-token provider) so nothing touches the network. Also covers
// the credential-missing and error paths (must return "failed", never throw) and
// exercises the default WebCrypto signers to prove they emit verifiable JWTs.
import { describe, it, expect } from "vitest";
import type { mobile } from "@dub/types";
import { ApnsAdapter, FcmAdapter } from "../src/push";
import { sendApns } from "../src/apns";
import { sendFcm } from "../src/fcm";
import type { DeviceRecord } from "../src/devices";

const PAYLOAD: mobile.MobilePushPayload = { title: "Hi", body: "There", data: { k: "v" } };

function dev(pushToken: string, platform: mobile.MobilePlatform): DeviceRecord {
  return {
    id: "mdev_1",
    userId: "usr_alice",
    platform,
    pushToken,
    appVersion: null,
    locale: null,
    disabledAt: null,
    lastSeenAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

interface Call {
  url: string;
  init?: RequestInit;
}
function recorder(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
function nth(calls: Call[], i: number): Call {
  const c = calls[i];
  if (!c) throw new Error(`expected fetch call #${i}`);
  return c;
}
function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}
function splitJwt(jwt: string): [string, string, string] {
  const p = jwt.split(".");
  return [p[0] ?? "", p[1] ?? "", p[2] ?? ""];
}

const APNS_CREDS = { keyP8: "unused", keyId: "KID1234567", teamId: "TEAM123456", bundleId: "jp.devhub.app" };
const FCM_SA = { client_email: "svc@proj.iam.gserviceaccount.com", private_key: "unused", project_id: "proj_1" };

// ---- APNs ----

describe("sendApns", () => {
  it("posts to /3/device/<token> with the provider JWT and maps 200 -> sent", async () => {
    const { fetchImpl, calls } = recorder(() => new Response("", { status: 200 }));
    const res = await sendApns({
      credentials: APNS_CREDS,
      device: { pushToken: "tok_dev" },
      payload: PAYLOAD,
      fetchImpl,
      signer: async () => "JWT.SIGNED",
    });

    expect(res).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(nth(calls, 0).url).toBe("https://api.push.apple.com/3/device/tok_dev");
    expect(headerOf(nth(calls, 0).init, "authorization")).toBe("bearer JWT.SIGNED");
    expect(headerOf(nth(calls, 0).init, "apns-topic")).toBe("jp.devhub.app");
    expect(headerOf(nth(calls, 0).init, "apns-push-type")).toBe("alert");
    expect(JSON.parse(String(nth(calls, 0).init?.body))).toEqual({
      aps: { alert: { title: "Hi", body: "There" } },
      k: "v",
    });
  });

  it("honours a custom (sandbox) host", async () => {
    const rec = recorder(() => new Response("", { status: 200 }));
    await sendApns({
      credentials: APNS_CREDS,
      device: { pushToken: "t" },
      payload: PAYLOAD,
      fetchImpl: rec.fetchImpl,
      signer: async () => "j",
      host: "api.sandbox.push.apple.com",
    });
    expect(nth(rec.calls, 0).url).toBe("https://api.sandbox.push.apple.com/3/device/t");
  });

  it("maps 410 -> token_invalid", async () => {
    const { fetchImpl } = recorder(() => new Response("", { status: 410 }));
    const res = await sendApns({ credentials: APNS_CREDS, device: { pushToken: "t" }, payload: PAYLOAD, fetchImpl, signer: async () => "j" });
    expect(res).toBe("token_invalid");
  });

  it("maps a BadDeviceToken reason (400) -> token_invalid", async () => {
    const { fetchImpl } = recorder(() => new Response(JSON.stringify({ reason: "BadDeviceToken" }), { status: 400 }));
    const res = await sendApns({ credentials: APNS_CREDS, device: { pushToken: "t" }, payload: PAYLOAD, fetchImpl, signer: async () => "j" });
    expect(res).toBe("token_invalid");
  });

  it("maps a non-token error (413 PayloadTooLarge) -> failed", async () => {
    const { fetchImpl } = recorder(() => new Response(JSON.stringify({ reason: "PayloadTooLarge" }), { status: 413 }));
    const res = await sendApns({ credentials: APNS_CREDS, device: { pushToken: "t" }, payload: PAYLOAD, fetchImpl, signer: async () => "j" });
    expect(res).toBe("failed");
  });

  it("maps a 500 -> failed", async () => {
    const { fetchImpl } = recorder(() => new Response("", { status: 500 }));
    const res = await sendApns({ credentials: APNS_CREDS, device: { pushToken: "t" }, payload: PAYLOAD, fetchImpl, signer: async () => "j" });
    expect(res).toBe("failed");
  });
});

describe("ApnsAdapter", () => {
  it("returns failed without credentials and never calls fetch (boolean false)", async () => {
    const adapter = new ApnsAdapter(false);
    // No fetch injected: if send() tried to hit the network it would throw and fail the assertion.
    expect(await adapter.send(dev("t", "ios"), PAYLOAD)).toBe("failed");
  });

  it("returns failed for the legacy boolean-true wiring (flag set, no credentials passed)", async () => {
    expect(await new ApnsAdapter(true).send(dev("t", "ios"), PAYLOAD)).toBe("failed");
  });

  it("delegates to sendApns and maps token_invalid", async () => {
    const rec = recorder(() => new Response("", { status: 410 }));
    const adapter = new ApnsAdapter({ credentials: APNS_CREDS, fetchImpl: rec.fetchImpl, signer: async () => "j" });
    expect(await adapter.send(dev("tok", "ios"), PAYLOAD)).toBe("token_invalid");
    expect(nth(rec.calls, 0).url).toBe("https://api.push.apple.com/3/device/tok");
  });

  it("returns failed (never throws) when the transport errors", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const adapter = new ApnsAdapter({ credentials: APNS_CREDS, fetchImpl, signer: async () => "j" });
    expect(await adapter.send(dev("t", "ios"), PAYLOAD)).toBe("failed");
  });
});

// ---- FCM ----

describe("sendFcm", () => {
  it("acquires a token then posts messages:send and maps 200 -> sent", async () => {
    const { fetchImpl, calls } = recorder(() => new Response(JSON.stringify({ name: "projects/proj_1/messages/1" }), { status: 200 }));
    const res = await sendFcm({
      serviceAccount: FCM_SA,
      projectId: "proj_1",
      device: { pushToken: "fcm_tok" },
      payload: PAYLOAD,
      fetchImpl,
      accessTokenProvider: async () => "at_123",
    });

    expect(res).toBe("sent");
    expect(nth(calls, 0).url).toBe("https://fcm.googleapis.com/v1/projects/proj_1/messages:send");
    expect(headerOf(nth(calls, 0).init, "authorization")).toBe("Bearer at_123");
    expect(JSON.parse(String(nth(calls, 0).init?.body))).toEqual({
      message: { token: "fcm_tok", notification: { title: "Hi", body: "There" }, data: { k: "v" } },
    });
  });

  it("maps an UNREGISTERED FcmError (404) -> token_invalid", async () => {
    const body = JSON.stringify({ error: { status: "NOT_FOUND", details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }] } });
    const { fetchImpl } = recorder(() => new Response(body, { status: 404 }));
    const res = await sendFcm({ serviceAccount: FCM_SA, projectId: "proj_1", device: { pushToken: "t" }, payload: PAYLOAD, fetchImpl, accessTokenProvider: async () => "at" });
    expect(res).toBe("token_invalid");
  });

  it("maps an INVALID_ARGUMENT FcmError (400) -> token_invalid", async () => {
    const body = JSON.stringify({ error: { status: "INVALID_ARGUMENT", details: [{ errorCode: "INVALID_ARGUMENT" }] } });
    const { fetchImpl } = recorder(() => new Response(body, { status: 400 }));
    const res = await sendFcm({ serviceAccount: FCM_SA, projectId: "proj_1", device: { pushToken: "t" }, payload: PAYLOAD, fetchImpl, accessTokenProvider: async () => "at" });
    expect(res).toBe("token_invalid");
  });

  it("maps a bare 404 -> token_invalid", async () => {
    const { fetchImpl } = recorder(() => new Response("", { status: 404 }));
    const res = await sendFcm({ serviceAccount: FCM_SA, projectId: "proj_1", device: { pushToken: "t" }, payload: PAYLOAD, fetchImpl, accessTokenProvider: async () => "at" });
    expect(res).toBe("token_invalid");
  });

  it("maps a 500 -> failed", async () => {
    const { fetchImpl } = recorder(() => new Response("", { status: 500 }));
    const res = await sendFcm({ serviceAccount: FCM_SA, projectId: "proj_1", device: { pushToken: "t" }, payload: PAYLOAD, fetchImpl, accessTokenProvider: async () => "at" });
    expect(res).toBe("failed");
  });
});

describe("FcmAdapter", () => {
  it("returns failed without a service account (boolean false), no fetch", async () => {
    expect(await new FcmAdapter(false).send(dev("t", "android"), PAYLOAD)).toBe("failed");
  });

  it("returns failed when neither options.projectId nor service_account.project_id is present", async () => {
    const rec = recorder(() => new Response("", { status: 200 }));
    const adapter = new FcmAdapter({
      serviceAccount: { client_email: "x", private_key: "y" },
      fetchImpl: rec.fetchImpl,
      accessTokenProvider: async () => "at",
    });
    expect(await adapter.send(dev("t", "android"), PAYLOAD)).toBe("failed");
    expect(rec.calls).toHaveLength(0);
  });

  it("falls back to service_account.project_id and delegates to sendFcm", async () => {
    const rec = recorder(() => new Response(JSON.stringify({ name: "ok" }), { status: 200 }));
    const adapter = new FcmAdapter({ serviceAccount: FCM_SA, fetchImpl: rec.fetchImpl, accessTokenProvider: async () => "at_zzz" });
    expect(await adapter.send(dev("tok", "android"), PAYLOAD)).toBe("sent");
    expect(nth(rec.calls, 0).url).toBe("https://fcm.googleapis.com/v1/projects/proj_1/messages:send");
    expect(headerOf(nth(rec.calls, 0).init, "authorization")).toBe("Bearer at_zzz");
  });

  it("returns failed (never throws) when the transport errors", async () => {
    const fetchImpl = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const adapter = new FcmAdapter({ serviceAccount: FCM_SA, fetchImpl, accessTokenProvider: async () => "at" });
    expect(await adapter.send(dev("t", "android"), PAYLOAD)).toBe("failed");
  });
});

// ---- default WebCrypto signers (network-free, but real crypto) ----

type GenAlgo = Parameters<typeof crypto.subtle.generateKey>[0];

async function generatePkcs8Pem(algo: GenAlgo): Promise<{ pem: string; publicKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey(algo, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer);
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  const b64 = (btoa(bin).match(/.{1,64}/g) ?? []).join("\n");
  return { pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`, publicKey: kp.publicKey };
}
function b64urlToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function jsonFromB64url<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T;
}

describe("default signers (real WebCrypto)", () => {
  it("APNs default ES256 signer produces a verifiable JWT with kid/iss/iat", async () => {
    const { pem, publicKey } = await generatePkcs8Pem({ name: "ECDSA", namedCurve: "P-256" });
    let sentJwt = "";
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentJwt = String(headerOf(init, "authorization")).replace(/^bearer /, "");
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await new ApnsAdapter({
      credentials: { keyP8: pem, keyId: "KID1234567", teamId: "TEAM123456", bundleId: "jp.devhub.app" },
      fetchImpl,
      now: () => 1_700_000_000_000,
    }).send(dev("t", "ios"), PAYLOAD);

    expect(res).toBe("sent");
    const [h, c, sig] = splitJwt(sentJwt);
    expect(jsonFromB64url<{ alg: string; kid: string }>(h)).toMatchObject({ alg: "ES256", kid: "KID1234567" });
    expect(jsonFromB64url<{ iss: string; iat: number }>(c)).toEqual({ iss: "TEAM123456", iat: 1_700_000_000 });
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      b64urlToBytes(sig),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });

  it("FCM default provider signs an RS256 assertion, exchanges it, then sends", async () => {
    const { pem, publicKey } = await generatePkcs8Pem({
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    });
    const calls: Call[] = [];
    let assertion = "";
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("oauth2")) {
        assertion = new URLSearchParams(String(init?.body)).get("assertion") ?? "";
        return new Response(JSON.stringify({ access_token: "at_real" }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await new FcmAdapter({
      serviceAccount: { client_email: "svc@proj.iam.gserviceaccount.com", private_key: pem, project_id: "proj_1" },
      fetchImpl,
      now: () => 1_700_000_000_000,
    }).send(dev("fcm_tok", "android"), PAYLOAD);

    expect(res).toBe("sent");
    expect(nth(calls, 0).url).toBe("https://oauth2.googleapis.com/token");
    expect(nth(calls, 1).url).toBe("https://fcm.googleapis.com/v1/projects/proj_1/messages:send");
    expect(headerOf(nth(calls, 1).init, "authorization")).toBe("Bearer at_real");

    const [h, c, sig] = splitJwt(assertion);
    expect(jsonFromB64url<{ alg: string }>(h)).toMatchObject({ alg: "RS256" });
    expect(jsonFromB64url<{ iss: string; aud: string; scope: string }>(c)).toMatchObject({
      iss: "svc@proj.iam.gserviceaccount.com",
      aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    });
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      b64urlToBytes(sig),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });
});
