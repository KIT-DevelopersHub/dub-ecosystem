import { describe, it, expect, vi } from "vitest";
import { CommonErrorCodes } from "@dub/errors";
import { createApp } from "../src/app";
import { createDriveShareService } from "../src/service";
import { createMockDriveShareClient } from "../src/mock-client";
import { createGoogleAccountService, isAllowedRedirectUri, resolveDriveCredentials } from "../src/google-account";
import { createInMemoryGoogleAccountStore } from "../src/google-account-store";
import { importTokenKey, openToken, sealToken } from "../src/google/crypto";
import type { Env } from "../src/env";
import { AUTHED, buildRoleGrants, fakeRoster, memAuthzHolding } from "./helpers";

const ORG = "org_devhub";
const KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const REDIRECT = "https://dub-fe2-app-shell.example.workers.dev/admin/roles";
const T0 = Date.parse("2026-10-10T00:00:00.000Z");

const WEB_ENV: Env = {
  GOOGLE_HACKIT_OAUTH_WEB_CLIENT_ID: "web-cid",
  GOOGLE_HACKIT_OAUTH_WEB_CLIENT_SECRET: "web-sec",
  DRIVESHARE_TOKEN_ENC_KEY: KEY_B64,
} as Env;
const SECRET_ENV = {
  GOOGLE_HACKIT_OAUTH_CLIENT_ID: "desk-cid",
  GOOGLE_HACKIT_OAUTH_CLIENT_SECRET: "desk-sec",
  GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN: "secret-rt",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fake Google: token endpoint + Drive about. `tokenReply` decides the token endpoint answer. */
function fakeGoogle(tokenReply: (form: URLSearchParams) => Response, email = "new-owner@gmail.com") {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) return tokenReply(new URLSearchParams(String(init?.body)));
    if (url.startsWith("https://www.googleapis.com/drive/v3/about")) return json({ user: { emailAddress: email } });
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function setup(opts: { env?: Env; fetchImpl?: typeof fetch; now?: () => number } = {}) {
  const env = opts.env ?? WEB_ENV;
  const store = createInMemoryGoogleAccountStore();
  const key = await importTokenKey(env.DRIVESHARE_TOKEN_ENC_KEY);
  const svc = createGoogleAccountService({
    env,
    store,
    orgId: ORG,
    key,
    fetchImpl: opts.fetchImpl ?? (fakeGoogle(() => json({ access_token: "at" })) as unknown as typeof fetch),
    now: opts.now ?? (() => T0),
  });
  return { env, store, key, svc };
}

const stateOf = (authUrl: string) => new URL(authUrl).searchParams.get("state")!;

describe("crypto", () => {
  it("round-trips and binds the ciphertext to the org", async () => {
    const key = (await importTokenKey(KEY_B64))!;
    const sealed = await sealToken(key, ORG, "rt-plain");
    expect(sealed.cipher).not.toContain("rt-plain");
    expect(await openToken(key, ORG, sealed)).toBe("rt-plain");
    await expect(openToken(key, "org_other", sealed)).rejects.toBeTruthy();
  });

  it("rejects a key that is not 256 bits", async () => {
    expect(await importTokenKey(undefined)).toBeNull();
    expect(await importTokenKey(btoa("short"))).toBeNull();
    expect(await importTokenKey("%%%not-base64")).toBeNull();
  });
});

describe("redirect URI allowlist", () => {
  it("accepts only the SPA return page on https (or localhost)", () => {
    expect(isAllowedRedirectUri(REDIRECT)).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:5173/admin/roles")).toBe(true);
    expect(isAllowedRedirectUri("http://evil.example/admin/roles")).toBe(false);
    expect(isAllowedRedirectUri("https://x.example/admin/users")).toBe(false);
    expect(isAllowedRedirectUri(`${REDIRECT}?next=https://evil`)).toBe(false);
    expect(isAllowedRedirectUri(42)).toBe(false);
  });
});

describe("connect flow", () => {
  it("start: stores a single-use state and asks Google for an offline, always-consented grant", async () => {
    const { svc, store } = await setup();
    const { authUrl } = await svc.startConnect("usr_admin", REDIRECT);
    const u = new URL(authUrl);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("client_id")).toBe("web-cid");
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive");
    const row = store.states.get(stateOf(authUrl))!;
    expect(row).toMatchObject({ userId: "usr_admin", redirectUri: REDIRECT, orgId: ORG });
  });

  it("start: refuses an unlisted redirect URI and a server without client/key", async () => {
    const { svc } = await setup();
    await expect(svc.startConnect("usr_admin", "https://evil.example/cb")).rejects.toMatchObject({
      code: CommonErrorCodes.VALIDATION_FAILED,
    });
    const bare = await setup({ env: {} as Env });
    await expect(bare.svc.startConnect("usr_admin", REDIRECT)).rejects.toMatchObject({ code: CommonErrorCodes.CONFLICT });
  });

  it("callback: exchanges with the stored redirect URI, seals the token, and never returns it", async () => {
    const google = fakeGoogle((form) => {
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("redirect_uri")).toBe(REDIRECT);
      expect(form.get("client_secret")).toBe("web-sec");
      return json({ access_token: "at", refresh_token: "rt-new" });
    });
    const { svc, store, key } = await setup({ fetchImpl: google as unknown as typeof fetch });
    const { authUrl } = await svc.startConnect("usr_admin", REDIRECT);

    const status = await svc.completeConnect("usr_admin", { code: "c0de", state: stateOf(authUrl) });
    expect(status).toEqual({
      source: "connected",
      email: "new-owner@gmail.com",
      connectedAt: "2026-10-10T00:00:00.000Z",
      connectedBy: "usr_admin",
      needsReconnect: false,
      canConnect: true,
    });
    expect(JSON.stringify(status)).not.toContain("rt-new");

    const row = (await store.get(ORG))!;
    expect(row.clientId).toBe("web-cid");
    expect(JSON.stringify(row)).not.toContain("rt-new");
    expect(await openToken(key!, ORG, { cipher: row.tokenCipher, iv: row.tokenIv })).toBe("rt-new");
  });

  it("callback: a state is single-use", async () => {
    const google = fakeGoogle(() => json({ access_token: "at", refresh_token: "rt" }));
    const { svc } = await setup({ fetchImpl: google as unknown as typeof fetch });
    const state = stateOf((await svc.startConnect("usr_admin", REDIRECT)).authUrl);
    await svc.completeConnect("usr_admin", { code: "c", state });
    await expect(svc.completeConnect("usr_admin", { code: "c", state })).rejects.toMatchObject({
      code: CommonErrorCodes.VALIDATION_FAILED,
    });
  });

  it("callback: rejects a forged, expired, or someone else's state (CSRF)", async () => {
    let now = T0;
    const { svc } = await setup({ now: () => now });
    await expect(svc.completeConnect("usr_admin", { code: "c", state: "forged" })).rejects.toMatchObject({
      code: CommonErrorCodes.VALIDATION_FAILED,
    });

    const other = stateOf((await svc.startConnect("usr_admin", REDIRECT)).authUrl);
    const res = svc.completeConnect("usr_other_admin", { code: "c", state: other });
    await expect(res).rejects.toMatchObject({ code: CommonErrorCodes.FORBIDDEN, status: 403 });

    const stale = stateOf((await svc.startConnect("usr_admin", REDIRECT)).authUrl);
    now = T0 + 11 * 60 * 1000;
    await expect(svc.completeConnect("usr_admin", { code: "c", state: stale })).rejects.toMatchObject({
      code: CommonErrorCodes.VALIDATION_FAILED,
    });
  });

  it("callback: no refresh token from Google is an error, not a half-connected account", async () => {
    const google = fakeGoogle(() => json({ access_token: "at" }));
    const { svc, store } = await setup({ fetchImpl: google as unknown as typeof fetch });
    const state = stateOf((await svc.startConnect("usr_admin", REDIRECT)).authUrl);
    await expect(svc.completeConnect("usr_admin", { code: "c", state })).rejects.toMatchObject({
      code: CommonErrorCodes.VALIDATION_FAILED,
    });
    expect(await store.get(ORG)).toBeNull();
  });
});

describe("status + credential precedence", () => {
  it("none: no secret, nothing connected", async () => {
    const { svc } = await setup({ env: {} as Env });
    expect(await svc.status()).toMatchObject({ source: "none", email: null, needsReconnect: false, canConnect: false });
  });

  it("secret fallback: the existing secret keeps working and its account is named", async () => {
    const env = { ...SECRET_ENV } as Env;
    const { svc, store } = await setup({ env });
    expect(await svc.status()).toMatchObject({ source: "secret", email: "new-owner@gmail.com", needsReconnect: false });
    const resolved = await resolveDriveCredentials({ env, store, orgId: ORG, key: null });
    expect(resolved).toMatchObject({ source: "secret", credentials: { refreshToken: "secret-rt", clientId: "desk-cid" } });
  });

  it("the connected account wins over the secret, refreshed with the client that minted it", async () => {
    const env = { ...SECRET_ENV, ...WEB_ENV } as Env;
    const google = fakeGoogle(() => json({ access_token: "at", refresh_token: "rt-d1" }));
    const { svc, store, key } = await setup({ env, fetchImpl: google as unknown as typeof fetch });
    const state = stateOf((await svc.startConnect("usr_admin", REDIRECT)).authUrl);
    await svc.completeConnect("usr_admin", { code: "c", state });

    const resolved = await resolveDriveCredentials({ env, store, orgId: ORG, key });
    expect(resolved).toMatchObject({
      source: "connected",
      credentials: { refreshToken: "rt-d1", clientId: "web-cid", clientSecret: "web-sec" },
    });
  });

  it("invalid_grant (revoked / 7-day testing expiry) surfaces as needsReconnect", async () => {
    const env = { ...SECRET_ENV, ...WEB_ENV } as Env;
    let revoked = false;
    const google = fakeGoogle((form) =>
      form.get("grant_type") === "refresh_token" && revoked
        ? json({ error: "invalid_grant" }, 400)
        : json({ access_token: "at", refresh_token: "rt-d1" }),
    );
    const { svc } = await setup({ env, fetchImpl: google as unknown as typeof fetch });
    const state = stateOf((await svc.startConnect("usr_admin", REDIRECT)).authUrl);
    await svc.completeConnect("usr_admin", { code: "c", state });
    expect((await svc.status()).needsReconnect).toBe(false);

    revoked = true;
    expect(await svc.status()).toMatchObject({ source: "connected", email: "new-owner@gmail.com", needsReconnect: true });
  });

  it("a row sealed with a different key is ignored in favour of the secret", async () => {
    const env = { ...SECRET_ENV, ...WEB_ENV } as Env;
    const { store } = await setup({ env });
    const otherKey = (await importTokenKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))))!;
    const sealed = await sealToken(otherKey, ORG, "rt-x");
    await store.put({
      orgId: ORG, email: "x@gmail.com", clientId: "web-cid", tokenCipher: sealed.cipher, tokenIv: sealed.iv,
      connectedBy: "usr_admin", connectedAt: "t", updatedAt: "t",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = await resolveDriveCredentials({ env, store, orgId: ORG, key: await importTokenKey(KEY_B64) });
    expect(resolved.source).toBe("secret");
    expect(warn.mock.calls.join(" ")).not.toContain("rt-x");
    warn.mockRestore();
  });
});

describe("missing migration", () => {
  it("an unreadable account table falls back to the secret instead of failing Drive", async () => {
    const env = { ...SECRET_ENV, ...WEB_ENV } as Env;
    const store = createInMemoryGoogleAccountStore();
    store.get = async () => {
      throw new Error("no such table: driveshare_google_account");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = await resolveDriveCredentials({ env, store, orgId: ORG, key: await importTokenKey(KEY_B64) });
    expect(resolved.source).toBe("secret");
    warn.mockRestore();
  });
});

describe("routes (through policyGate)", () => {
  async function appWith(keys: Parameters<typeof memAuthzHolding>) {
    const client = createMockDriveShareClient();
    const service = createDriveShareService({ client, config: { listPageSize: 50 } });
    const { service: roleGrants } = buildRoleGrants({ drive: client, roster: fakeRoster({}) });
    const { svc } = await setup();
    return createApp({ service, roleGrants, authz: memAuthzHolding(...keys), googleAccount: svc });
  }
  const HDR = { ...AUTHED, "content-type": "application/json" };

  it("a Drive editor without identity:admin gets 403 (never 401) on every account route", async () => {
    const app = await appWith(["app:driveshare:view", "app:driveshare:edit", "drive:read", "drive:write"]);
    for (const [method, path] of [
      ["GET", "/driveshare/google-account"],
      ["POST", "/driveshare/google-account/connect"],
      ["POST", "/driveshare/google-account/callback"],
    ] as const) {
      const res = await app.request(path, { method, headers: HDR, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(res.status).toBe(403);
    }
  });

  it("an admin starts the round-trip as themselves", async () => {
    const app = await appWith(["app:driveshare:view", "app:driveshare:edit", "drive:write", "identity:admin"]);
    const res = await app.request("/driveshare/google-account/connect", {
      method: "POST",
      headers: HDR,
      body: JSON.stringify({ redirectUri: REDIRECT }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { authUrl: string }).authUrl).toContain("prompt=consent");
  });
});
