import { describe, it, expect, vi } from "vitest";
import { CommonErrorCodes } from "@dub/errors";
import { createApp } from "../src/app";
import { createDriveShareService } from "../src/service";
import { createMockDriveShareClient } from "../src/mock-client";
import { createGoogleAccountService, isAllowedRedirectUri, resolveDriveCredentials } from "../src/google-account";
import { createInMemoryGoogleAccountStore } from "../src/google-account-store";
import { importTokenKey, openToken, sealToken } from "../src/google/crypto";
import type { Env } from "../src/env";
import { SECRET_ACCOUNT_ID } from "../src/types";
import { AUTHED, buildRoleGrants, fakeRoster, memAuthzHolding, buildMeetings } from "./helpers";

const ORG = "org_devhub";
const KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const REDIRECT = "https://dub-fe2-app-shell.example.workers.dev/driveshare";
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
function fakeGoogle(tokenReply: (form: URLSearchParams) => Response, email: string | (() => string) = "new-owner@gmail.com") {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) return tokenReply(new URLSearchParams(String(init?.body)));
    if (url.startsWith("https://www.googleapis.com/drive/v3/about")) return json({ user: { emailAddress: typeof email === "string" ? email : email() } });
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
    newId: (() => {
      let n = 0;
      return () => `dga_${++n}`;
    })(),
  });
  return { env, store, key, svc };
}

const stateOf = (authUrl: string) => new URL(authUrl).searchParams.get("state")!;

/** Run the whole add-account round-trip for the admin. */
async function addAccount(svc: Awaited<ReturnType<typeof setup>>["svc"], userId = "usr_admin") {
  const state = stateOf((await svc.startConnect(userId, REDIRECT)).authUrl);
  return svc.completeConnect(userId, { code: "c", state });
}

describe("crypto", () => {
  it("round-trips and binds the ciphertext to its account row", async () => {
    const key = (await importTokenKey(KEY_B64))!;
    const sealed = await sealToken(key, `${ORG}/a@gmail.com`, "rt-plain");
    expect(sealed.cipher).not.toContain("rt-plain");
    expect(await openToken(key, `${ORG}/a@gmail.com`, sealed)).toBe("rt-plain");
    await expect(openToken(key, `${ORG}/b@gmail.com`, sealed)).rejects.toBeTruthy();
    await expect(openToken(key, `org_other/a@gmail.com`, sealed)).rejects.toBeTruthy();
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
    expect(isAllowedRedirectUri("http://localhost:5173/driveshare")).toBe(true);
    expect(isAllowedRedirectUri("http://evil.example/driveshare")).toBe(false);
    expect(isAllowedRedirectUri("https://x.example/admin/users")).toBe(false);
    expect(isAllowedRedirectUri(`${REDIRECT}?next=https://evil`)).toBe(false);
    expect(isAllowedRedirectUri(42)).toBe(false);
  });
});

describe("add-account flow", () => {
  it("start: stores a single-use state and asks Google for an offline, always-consented grant", async () => {
    const { svc, store } = await setup();
    const { authUrl } = await svc.startConnect("usr_admin", REDIRECT);
    const u = new URL(authUrl);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("client_id")).toBe("web-cid");
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(u.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/meetings.space.settings",
    );
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

  it("callback: exchanges with the stored redirect URI, seals the token, switches to it, never returns it", async () => {
    const google = fakeGoogle((form) => {
      if (form.get("grant_type") === "authorization_code") {
        expect(form.get("redirect_uri")).toBe(REDIRECT);
        expect(form.get("client_secret")).toBe("web-sec");
      }
      return json({ access_token: "at", refresh_token: "rt-new" });
    });
    const { svc, store, key } = await setup({ fetchImpl: google as unknown as typeof fetch });

    const status = await addAccount(svc);
    expect(status).toEqual({
      canConnect: true,
      accounts: [
        {
          id: "dga_1",
          kind: "connected",
          email: "new-owner@gmail.com",
          connectedAt: "2026-10-10T00:00:00.000Z",
          connectedBy: "usr_admin",
          active: true,
          needsReconnect: false,
          calendarMissing: false,
          meetMissing: false,
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain("rt-new");

    const row = (await store.getActive(ORG))!;
    expect(row.clientId).toBe("web-cid");
    expect(JSON.stringify(row)).not.toContain("rt-new");
    expect(await openToken(key!, `${ORG}/new-owner@gmail.com`, { cipher: row.tokenCipher, iv: row.tokenIv })).toBe("rt-new");
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

  it("callback: no refresh token from Google is an error, not a half-registered account", async () => {
    const google = fakeGoogle(() => json({ access_token: "at" }));
    const { svc, store } = await setup({ fetchImpl: google as unknown as typeof fetch });
    const state = stateOf((await svc.startConnect("usr_admin", REDIRECT)).authUrl);
    await expect(svc.completeConnect("usr_admin", { code: "c", state })).rejects.toMatchObject({
      code: CommonErrorCodes.VALIDATION_FAILED,
    });
    expect(await store.list(ORG)).toEqual([]);
  });
});

describe("several accounts: register, switch, remove", () => {
  async function twoAccounts(env: Env = WEB_ENV) {
    let who = "a@gmail.com";
    let rt = "rt-a";
    const google = fakeGoogle(() => json({ access_token: "at", refresh_token: rt }), () => who);
    const ctx = await setup({ env, fetchImpl: google as unknown as typeof fetch });
    await addAccount(ctx.svc);
    who = "b@gmail.com";
    rt = "rt-b";
    const status = await addAccount(ctx.svc);
    return { ...ctx, status, setRefresh: (v: string) => (rt = v), setWho: (v: string) => (who = v) };
  }
  const brief = (s: { accounts: { id: string; email: string | null; active: boolean }[] }) =>
    s.accounts.map((a) => `${a.id}:${a.email}:${a.active ? "active" : "-"}`);

  it("adding a second account keeps the first and switches to the new one", async () => {
    const { status } = await twoAccounts();
    expect(brief(status)).toEqual(["dga_1:a@gmail.com:-", "dga_2:b@gmail.com:active"]);
  });

  it("switching moves the Drive credentials to the chosen account", async () => {
    const { svc, store, env, key } = await twoAccounts();
    const status = await svc.switchTo("usr_admin", "dga_1");
    expect(brief(status)).toEqual(["dga_1:a@gmail.com:active", "dga_2:b@gmail.com:-"]);
    const resolved = await resolveDriveCredentials({ env, store, orgId: ORG, key });
    expect(resolved).toMatchObject({ source: "connected", credentials: { refreshToken: "rt-a" } });
  });

  it("adding the address in use again replaces its token in place (reconnect), no duplicate", async () => {
    const { svc, store, env, key, setRefresh } = await twoAccounts();
    setRefresh("rt-b2");
    const status = await addAccount(svc);
    expect(brief(status)).toEqual(["dga_1:a@gmail.com:-", "dga_2:b@gmail.com:active"]);
    const resolved = await resolveDriveCredentials({ env, store, orgId: ORG, key });
    expect(resolved).toMatchObject({ credentials: { refreshToken: "rt-b2" } });
  });

  it("reconnecting an account that is not in use refreshes its token but does not switch to it", async () => {
    const { svc, store, env, key, setRefresh, setWho } = await twoAccounts();
    setWho("a@gmail.com");
    setRefresh("rt-a3");
    const status = await addAccount(svc);
    expect(brief(status)).toEqual(["dga_1:a@gmail.com:-", "dga_2:b@gmail.com:active"]);
    const resolved = await resolveDriveCredentials({ env, store, orgId: ORG, key });
    expect(resolved).toMatchObject({ credentials: { refreshToken: "rt-b" } });
    const row = (await store.list(ORG)).find((r) => r.id === "dga_1")!;
    expect(await openToken(key!, `${ORG}/a@gmail.com`, { cipher: row.tokenCipher, iv: row.tokenIv })).toBe("rt-a3");
  });

  it("start: a reconnect preselects the account on Google's screen (login_hint)", async () => {
    const { svc } = await setup();
    const { authUrl } = await svc.startConnect("usr_admin", REDIRECT, "a@gmail.com");
    expect(new URL(authUrl).searchParams.get("login_hint")).toBe("a@gmail.com");
    expect(new URL((await svc.startConnect("usr_admin", REDIRECT)).authUrl).searchParams.has("login_hint")).toBe(false);
  });

  it("switching to an unknown account is 404 and changes nothing", async () => {
    const { svc } = await twoAccounts();
    await expect(svc.switchTo("usr_admin", "dga_nope")).rejects.toMatchObject({ status: 404 });
    await expect(svc.switchTo("usr_admin", undefined)).rejects.toMatchObject({ code: CommonErrorCodes.VALIDATION_FAILED });
    expect(brief(await svc.status())).toEqual(["dga_1:a@gmail.com:-", "dga_2:b@gmail.com:active"]);
  });

  it("an account not in use can be removed; the one in use cannot (409)", async () => {
    const { svc } = await twoAccounts();
    await expect(svc.remove("dga_2")).rejects.toMatchObject({ code: CommonErrorCodes.CONFLICT, status: 409 });
    expect(brief(await svc.remove("dga_1"))).toEqual(["dga_2:b@gmail.com:active"]);
    await expect(svc.remove("dga_1")).rejects.toMatchObject({ status: 404 });
  });

  it("the server's initial (secret) account is listed and can be switched back to", async () => {
    const env = { ...SECRET_ENV, ...WEB_ENV } as Env;
    const { svc, store, key } = await twoAccounts(env);
    expect((await svc.status()).accounts[0]).toMatchObject({ id: SECRET_ACCOUNT_ID, kind: "secret", active: false });

    const status = await svc.switchTo("usr_admin", SECRET_ACCOUNT_ID);
    expect(status.accounts.filter((a) => a.active).map((a) => a.id)).toEqual([SECRET_ACCOUNT_ID]);
    const resolved = await resolveDriveCredentials({ env, store, orgId: ORG, key });
    expect(resolved).toMatchObject({ source: "secret", credentials: { refreshToken: "secret-rt" } });
    // Now nothing registered is in use, so any of them may be removed.
    expect(brief(await svc.remove("dga_2"))).toEqual(["secret:b@gmail.com:active", "dga_1:a@gmail.com:-"]);
    await expect(svc.remove(SECRET_ACCOUNT_ID)).rejects.toMatchObject({ status: 404 });
  });

  it("while the secret is in use, reconnecting a registered account keeps the secret", async () => {
    const env = { ...SECRET_ENV, ...WEB_ENV } as Env;
    const { svc, setWho } = await twoAccounts(env);
    await svc.switchTo("usr_admin", SECRET_ACCOUNT_ID);
    setWho("a@gmail.com");
    const status = await addAccount(svc);
    expect(status.accounts.filter((a) => a.active).map((a) => a.id)).toEqual([SECRET_ACCOUNT_ID]);
  });

  it("switching to the secret when none is configured is 404", async () => {
    const { svc } = await twoAccounts();
    await expect(svc.switchTo("usr_admin", SECRET_ACCOUNT_ID)).rejects.toMatchObject({ status: 404 });
  });
});

describe("status + credential precedence", () => {
  it("none: no secret, nothing registered", async () => {
    const { svc } = await setup({ env: {} as Env });
    expect(await svc.status()).toEqual({ accounts: [], canConnect: false });
  });

  it("secret fallback: the existing secret keeps working and its account is named", async () => {
    const env = { ...SECRET_ENV } as Env;
    const { svc, store } = await setup({ env });
    expect(await svc.status()).toEqual({
      canConnect: false,
      accounts: [
        { id: SECRET_ACCOUNT_ID, kind: "secret", email: "new-owner@gmail.com", connectedAt: null, connectedBy: null, active: true, needsReconnect: false, calendarMissing: false, meetMissing: false },
      ],
    });
    const resolved = await resolveDriveCredentials({ env, store, orgId: ORG, key: null });
    expect(resolved).toMatchObject({ source: "secret", credentials: { refreshToken: "secret-rt", clientId: "desk-cid" } });
  });

  it("the selected account wins over the secret, refreshed with the client that minted it", async () => {
    const env = { ...SECRET_ENV, ...WEB_ENV } as Env;
    const google = fakeGoogle(() => json({ access_token: "at", refresh_token: "rt-d1" }));
    const { svc, store, key } = await setup({ env, fetchImpl: google as unknown as typeof fetch });
    await addAccount(svc);

    const resolved = await resolveDriveCredentials({ env, store, orgId: ORG, key });
    expect(resolved).toMatchObject({
      source: "connected",
      credentials: { refreshToken: "rt-d1", clientId: "web-cid", clientSecret: "web-sec" },
    });
  });

  it("invalid_grant (revoked / 7-day testing expiry) surfaces as needsReconnect on that account", async () => {
    const env = { ...SECRET_ENV, ...WEB_ENV } as Env;
    let revoked = false;
    const google = fakeGoogle((form) =>
      form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "rt-d1" && revoked
        ? json({ error: "invalid_grant" }, 400)
        : json({ access_token: "at", refresh_token: "rt-d1" }),
    );
    const { svc } = await setup({ env, fetchImpl: google as unknown as typeof fetch });
    await addAccount(svc);
    expect((await svc.status()).accounts.map((a) => a.needsReconnect)).toEqual([false, false]);

    revoked = true;
    const { accounts } = await svc.status();
    expect(accounts.find((a) => a.id === "dga_1")).toMatchObject({ email: "new-owner@gmail.com", active: true, needsReconnect: true });
    expect(accounts.find((a) => a.id === SECRET_ACCOUNT_ID)).toMatchObject({ needsReconnect: false });
  });

  it("a grant without the calendar scope surfaces as calendarMissing so the UI offers 再接続", async () => {
    const env = { ...SECRET_ENV, ...WEB_ENV } as Env;
    let scope: string | undefined = "https://www.googleapis.com/auth/drive";
    const google = fakeGoogle(() => json({ access_token: "at", refresh_token: "rt-d1", ...(scope ? { scope } : {}) }));
    const { svc } = await setup({ env, fetchImpl: google as unknown as typeof fetch });
    await addAccount(svc);
    expect((await svc.status()).accounts.find((a) => a.id === "dga_1")).toMatchObject({ needsReconnect: false, calendarMissing: true });

    scope = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar";
    expect((await svc.status()).accounts.map((a) => a.calendarMissing)).toEqual([false, false]);
    // Connected before the Meet scope was requested: reconnect to open Meet links.
    expect((await svc.status()).accounts.map((a) => a.meetMissing)).toEqual([true, true]);

    scope += " https://www.googleapis.com/auth/meetings.space.settings";
    expect((await svc.status()).accounts.map((a) => a.meetMissing)).toEqual([false, false]);

    // Google did not report scopes: not flagged (same as meetings calendarReady)
    scope = undefined;
    expect((await svc.status()).accounts.map((a) => a.calendarMissing)).toEqual([false, false]);
  });

  it("a row that no longer opens (rotated key) fails closed and asks to reconnect — never the secret", async () => {
    const env = { ...SECRET_ENV, ...WEB_ENV } as Env;
    const { store, svc } = await setup({ env });
    const otherKey = (await importTokenKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))))!;
    const sealed = await sealToken(otherKey, `${ORG}/x@gmail.com`, "rt-x");
    await store.upsert({
      id: "dga_x", orgId: ORG, email: "x@gmail.com", clientId: "web-cid", tokenCipher: sealed.cipher, tokenIv: sealed.iv,
      connectedBy: "usr_admin", connectedAt: "t", updatedAt: "t",
    });
    await store.setActive(ORG, "dga_x", "usr_admin", "t");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = await resolveDriveCredentials({ env, store, orgId: ORG, key: await importTokenKey(KEY_B64) });
    expect(resolved.source).toBe("unusable");
    expect(warn.mock.calls.join(" ")).not.toContain("rt-x");
    expect((await svc.status()).accounts.find((a) => a.id === "dga_x")).toMatchObject({ active: true, needsReconnect: true });
    warn.mockRestore();
  });

  it("a row whose Web client secret was removed is unusable too", async () => {
    const { store } = await setup();
    await store.upsert({
      id: "dga_x", orgId: ORG, email: "x@gmail.com", clientId: "web-cid", tokenCipher: "c", tokenIv: "i",
      connectedBy: "u", connectedAt: "t", updatedAt: "t",
    });
    await store.setActive(ORG, "dga_x", "u", "t");
    const env = { ...SECRET_ENV, DRIVESHARE_TOKEN_ENC_KEY: KEY_B64 } as Env;
    const resolved = await resolveDriveCredentials({ env, store, orgId: ORG, key: await importTokenKey(KEY_B64) });
    expect(resolved.source).toBe("unusable");
  });

  it("only the Web client can start a connect (the Desktop client cannot redirect to https)", async () => {
    const env = { ...SECRET_ENV, DRIVESHARE_TOKEN_ENC_KEY: KEY_B64 } as Env;
    const { svc } = await setup({ env });
    expect((await svc.status()).canConnect).toBe(false);
    await expect(svc.startConnect("usr_admin", REDIRECT)).rejects.toMatchObject({ code: CommonErrorCodes.CONFLICT });
  });
});

describe("missing migration", () => {
  const noTable = () => new Error("D1 query failed", { cause: new Error("no such table: driveshare_google_accounts") });

  it("a missing table falls back to the secret instead of failing Drive", async () => {
    const env = { ...SECRET_ENV, ...WEB_ENV } as Env;
    const store = createInMemoryGoogleAccountStore();
    store.getActive = async () => {
      throw noTable();
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = await resolveDriveCredentials({ env, store, orgId: ORG, key: await importTokenKey(KEY_B64) });
    expect(resolved.source).toBe("secret");
    warn.mockRestore();
  });

  it("any other D1 failure propagates (no silent switch to the secret's account)", async () => {
    const env = { ...SECRET_ENV, ...WEB_ENV } as Env;
    const store = createInMemoryGoogleAccountStore();
    store.getActive = async () => {
      throw new Error("D1 query failed", { cause: new Error("network connection lost") });
    };
    await expect(resolveDriveCredentials({ env, store, orgId: ORG, key: null })).rejects.toThrow("D1 query failed");
  });

  it("starting a connect without the table is a clear 409, not a 500", async () => {
    const { svc, store } = await setup();
    store.purgeExpiredStates = async () => {
      throw noTable();
    };
    await expect(svc.startConnect("usr_admin", REDIRECT)).rejects.toMatchObject({ code: CommonErrorCodes.CONFLICT, status: 409 });
  });
});

describe("routes (through policyGate)", () => {
  async function appWith(keys: Parameters<typeof memAuthzHolding>) {
    const client = createMockDriveShareClient();
    const service = createDriveShareService({ client, config: { listPageSize: 50 } });
    const { service: roleGrants } = buildRoleGrants({ drive: client, roster: fakeRoster({}) });
    const { svc } = await setup();
    return createApp({ service, roleGrants, authz: memAuthzHolding(...keys), googleAccount: svc, meetings: async () => buildMeetings().service });
  }
  const HDR = { ...AUTHED, "content-type": "application/json" };
  const ADMIN_KEYS = ["app:driveshare:view", "app:driveshare:edit", "drive:settings_view", "drive:settings_edit"] as Parameters<typeof memAuthzHolding>;

  it("a Drive editor without the 「設定」 keys gets 403 (never 401) on every account route", async () => {
    const app = await appWith(["app:driveshare:view", "app:driveshare:edit", "drive:read", "drive:write", "identity:admin"]);
    for (const [method, path] of [
      ["GET", "/driveshare/google-account"],
      ["POST", "/driveshare/google-account/connect"],
      ["POST", "/driveshare/google-account/callback"],
      ["POST", "/driveshare/google-account/active"],
      ["DELETE", "/driveshare/google-account/accounts/dga_1"],
    ] as const) {
      const res = await app.request(path, { method, headers: HDR, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(res.status).toBe(403);
    }
  });

  it("「設定」 = 閲覧 reads the list but every change is 403", async () => {
    const app = await appWith(["app:driveshare:view", "app:driveshare:edit", "drive:settings_view"]);
    expect((await app.request("/driveshare/google-account", { headers: HDR })).status).toBe(200);
    const res = await app.request("/driveshare/google-account/connect", { method: "POST", headers: HDR, body: JSON.stringify({ redirectUri: REDIRECT }) });
    expect(res.status).toBe(403);
  });

  it("an admin starts the round-trip as themselves", async () => {
    const app = await appWith(ADMIN_KEYS);
    const res = await app.request("/driveshare/google-account/connect", {
      method: "POST",
      headers: HDR,
      body: JSON.stringify({ redirectUri: REDIRECT }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { authUrl: string }).authUrl).toContain("prompt=consent");
  });

  it("an admin switching to an unknown account gets 404; removing one gets 404", async () => {
    const app = await appWith(ADMIN_KEYS);
    const sw = await app.request("/driveshare/google-account/active", { method: "POST", headers: HDR, body: JSON.stringify({ accountId: "dga_nope" }) });
    expect(sw.status).toBe(404);
    const rm = await app.request("/driveshare/google-account/accounts/dga_nope", { method: "DELETE", headers: HDR });
    expect(rm.status).toBe(404);
  });
});
