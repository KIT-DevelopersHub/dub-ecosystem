import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app";
import { seedPasswordCredential } from "../src/passwords";
import { fakeUser, getInit, jsonInit, makeHarness, type TestHarness } from "./helpers";
import { SoftAuthenticator } from "./authenticator";

const RP = { rpId: "app.test.dev", origin: "https://app.test.dev" };
const USER = "usr_passkey01";
const EMAIL = "pk@developershub.jp";
const PASSWORD = "correct-horse";

type Json = Record<string, unknown>;
const body = async (r: Response): Promise<Json> => (await r.json()) as Json;
const code = async (r: Response): Promise<string> => ((await r.json()) as { error: { code: string } }).error.code;

async function setup(h: TestHarness = makeHarness(), userId = USER, email = EMAIL) {
  h.identity.users.set(userId, fakeUser(email, "Passkey User", { id: userId }));
  await seedPasswordCredential(h.deps.passwords, email, PASSWORD);
  const { token } = await h.deps.sessions.create(userId, "web");
  return { h, app: buildApp(h.deps), token };
}

async function register(app: ReturnType<typeof buildApp>, token: string, auth = new SoftAuthenticator(RP)) {
  const opts = await app.request("/auth/passkey/register/options", jsonInit({ password: PASSWORD }, { bearer: token }));
  expect(opts.status).toBe(200);
  const options = (await opts.json()) as { challenge: string; user: { id: string } };
  const res = await app.request("/auth/passkey/register/verify", jsonInit({ response: await auth.create(options), label: "MacBook" }, { bearer: token }));
  return { res, auth };
}

async function loginOptions(app: ReturnType<typeof buildApp>) {
  const r = await app.request("/auth/passkey/login/options", jsonInit({}));
  expect(r.status).toBe(200);
  return (await r.json()) as { challenge: string; rpId: string; userVerification: string };
}

describe("passkey registration", () => {
  it("registers with session + step-up password, then lists it", async () => {
    const { h, app, token } = await setup();
    const { res } = await register(app, token);
    expect(res.status).toBe(200);
    const list = await body(await app.request("/auth/passkeys", getInit({ bearer: token })));
    expect((list.items as Json[]).map((p) => p.label)).toEqual(["MacBook"]);
    expect(Object.keys((list.items as Json[])[0]!)).not.toContain("publicKey"); // no key material on the wire
    expect(h.audit.records.some((r) => r.action === "auth.passkey.registered" && r.result === "success")).toBe(true);
  });

  it("refuses options without a session", async () => {
    const { app } = await setup();
    const r = await app.request("/auth/passkey/register/options", jsonInit({ password: PASSWORD }));
    expect(r.status).toBe(401);
  });

  it("refuses options on a wrong step-up password and records the failure", async () => {
    const { h, app, token } = await setup();
    const r = await app.request("/auth/passkey/register/options", jsonInit({ password: "nope" }, { bearer: token }));
    expect(r.status).toBe(403); // NOT 401: the SPA would treat that as a dead session and log out
    expect(await code(r)).toBe("AUTH_STEP_UP_FAILED");
    expect(h.identity.challenges.size).toBe(0); // no challenge minted
    expect(h.audit.records.some((a) => a.action === "auth.passkey.registered" && a.details?.reason === "step_up_failed")).toBe(true);
  });

  it("a challenge minted for user A cannot be redeemed by user B's session", async () => {
    const { h, app, token } = await setup();
    const other = await setup(h, "usr_other0001", "other@developershub.jp");
    const opts = (await (await app.request("/auth/passkey/register/options", jsonInit({ password: PASSWORD }, { bearer: token }))).json()) as {
      challenge: string;
      user: { id: string };
    };
    const response = await new SoftAuthenticator(RP).create(opts);
    const r = await app.request("/auth/passkey/register/verify", jsonInit({ response }, { bearer: other.token }));
    expect(r.status).toBe(400);
    expect(h.identity.passkeys.size).toBe(0);
  });

  it("a login challenge cannot complete a registration", async () => {
    const { app, token } = await setup();
    const { challenge } = await loginOptions(app);
    const response = await new SoftAuthenticator(RP).create({ challenge, user: { id: "x" } });
    const r = await app.request("/auth/passkey/register/verify", jsonInit({ response }, { bearer: token }));
    expect(r.status).toBe(400);
  });

  it("rejects a registration for another rpId / origin and without user verification", async () => {
    for (const [auth, over] of [
      [new SoftAuthenticator(RP), { rpId: "evil.test" }],
      [new SoftAuthenticator(RP), { origin: "https://evil.test" }],
      [new SoftAuthenticator({ ...RP, noUserVerification: true }), {}],
    ] as const) {
      const { app, token } = await setup();
      const opts = (await (await app.request("/auth/passkey/register/options", jsonInit({ password: PASSWORD }, { bearer: token }))).json()) as {
        challenge: string;
        user: { id: string };
      };
      const r = await app.request("/auth/passkey/register/verify", jsonInit({ response: await auth.create(opts, over) }, { bearer: token }));
      expect(r.status).toBe(400); // registration failures never 401 (would log the user out)
    }
  });

  it("refuses registering the same authenticator twice", async () => {
    const { app, token } = await setup();
    const { auth } = await register(app, token);
    const { res } = await register(app, token, auth);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("AUTH_PASSKEY_DUPLICATE");
  });
});

describe("passkey login", () => {
  it("logs in with a registered passkey and mints a normal web session", async () => {
    const { h, app, token } = await setup();
    const { auth } = await register(app, token);
    const options = await loginOptions(app);
    expect(options.rpId).toBe(RP.rpId);
    expect(options.userVerification).toBe("required");
    const r = await app.request("/auth/passkey/login/verify", jsonInit({ response: await auth.get(options) }));
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/^dub_session=/);
    const minted = (await r.json()) as { token: string };
    expect((await h.deps.sessions.verify(minted.token)).valid).toBe(true);
    expect([...h.identity.passkeys.values()][0]!.signCount).toBe(1);
    expect(h.audit.records.some((a) => a.action === "auth.session.login" && a.details?.method === "passkey" && a.result === "success")).toBe(true);
  });

  it("a challenge is single-use: replaying the same assertion fails", async () => {
    // Zero-counter authenticator (synced passkeys): the counter check cannot catch the
    // replay, so this isolates the challenge's single-use deletion.
    const { app, token } = await setup();
    const { auth } = await register(app, token, new SoftAuthenticator({ ...RP, zeroCounter: true }));
    const response = await auth.get(await loginOptions(app));
    expect((await app.request("/auth/passkey/login/verify", jsonInit({ response }))).status).toBe(200);
    expect((await app.request("/auth/passkey/login/verify", jsonInit({ response }))).status).toBe(401);
  });

  it("a registration challenge cannot complete a login", async () => {
    const { app, token } = await setup();
    const { auth } = await register(app, token);
    const reg = (await (await app.request("/auth/passkey/register/options", jsonInit({ password: PASSWORD }, { bearer: token }))).json()) as {
      challenge: string;
    };
    const r = await app.request("/auth/passkey/login/verify", jsonInit({ response: await auth.get(reg) }));
    expect(r.status).toBe(401);
  });

  it("rejects a signature counter that did not advance (cloned authenticator)", async () => {
    const { h, app, token } = await setup();
    const { auth } = await register(app, token);
    expect((await app.request("/auth/passkey/login/verify", jsonInit({ response: await auth.get(await loginOptions(app)) }))).status).toBe(200);
    const replayed = await auth.get(await loginOptions(app), { counterStep: 0 });
    const r = await app.request("/auth/passkey/login/verify", jsonInit({ response: replayed }));
    expect(r.status).toBe(401);
    expect(h.audit.records.some((a) => a.action === "auth.session.login" && a.details?.reason === "verification_failed")).toBe(true);
  });

  it("rejects rpId / origin mismatch, missing UV, unknown credential and a foreign userHandle", async () => {
    const { app, token } = await setup();
    const { auth } = await register(app, token);
    for (const over of [{ rpId: "evil.test" }, { origin: "https://evil.test" }, { userHandle: "c29tZW9uZS1lbHNl" }]) {
      const r = await app.request("/auth/passkey/login/verify", jsonInit({ response: await auth.get(await loginOptions(app), over) }));
      expect(r.status).toBe(401);
      expect(await code(r)).toBe("AUTH_PASSKEY_FAILED");
    }
    const stranger = new SoftAuthenticator(RP);
    await stranger.create({ challenge: "x", user: { id: "x" } });
    expect((await app.request("/auth/passkey/login/verify", jsonInit({ response: await stranger.get(await loginOptions(app)) }))).status).toBe(401);
  });

  it("a valid passkey of a disabled account does not log in", async () => {
    const { h, app, token } = await setup();
    const { auth } = await register(app, token);
    h.identity.users.set(USER, fakeUser(EMAIL, "Passkey User", { id: USER, status: "disabled" }));
    const r = await app.request("/auth/passkey/login/verify", jsonInit({ response: await auth.get(await loginOptions(app)) }));
    expect(r.status).toBe(403);
  });

  it("login/options writes nothing to KV (the free-tier quota sessions depend on)", async () => {
    const { h, app } = await setup();
    const before = h.kv.puts.length;
    await loginOptions(app);
    expect(h.kv.puts.length).toBe(before);
    expect(h.identity.challenges.size).toBe(1);
  });

  it("a malformed userHandle is a clean 401, not a 500", async () => {
    const { app, token } = await setup();
    const { auth } = await register(app, token);
    const r = await app.request("/auth/passkey/login/verify", jsonInit({ response: await auth.get(await loginOptions(app), { userHandle: "%%%" }) }));
    expect(r.status).toBe(401);
  });

  it("is disabled (404) when the environment has no WEBAUTHN_RP_ID", async () => {
    const { app } = await setup(makeHarness({ WEBAUTHN_RP_ID: "" }));
    const r = await app.request("/auth/passkey/login/options", jsonInit({}));
    expect(r.status).toBe(404);
    expect(await code(r)).toBe("AUTH_PASSKEY_DISABLED");
  });
});

describe("passkey management", () => {
  it("renames and deletes only the caller's own passkeys", async () => {
    const { h, app, token } = await setup();
    const { auth } = await register(app, token);
    const other = await setup(h, "usr_other0001", "other@developershub.jp");
    const path = `/auth/passkeys/${auth.credentialId}`;
    const patch = (t: string) => ({ ...jsonInit({ label: "iPhone" }, { bearer: t }), method: "PATCH" });
    const del = (t: string) => ({ ...getInit({ bearer: t }), method: "DELETE" });

    expect((await app.request(path, patch(other.token))).status).toBe(404);
    expect((await app.request(path, del(other.token))).status).toBe(404);
    expect((await app.request(path, patch(token))).status).toBe(200);
    expect(h.identity.passkeys.get(auth.credentialId)!.label).toBe("iPhone");
    expect((await app.request(path, del(token))).status).toBe(204);
    expect(h.identity.passkeys.size).toBe(0);
  });

  it("refuses to delete the last passkey of an account that has no password", async () => {
    const { h, app, token } = await setup();
    const { auth } = await register(app, token);
    h.kv.store.delete(`pwcred:${EMAIL}`); // password removed => the passkey is the only way in
    const r = await app.request(`/auth/passkeys/${auth.credentialId}`, { ...getInit({ bearer: token }), method: "DELETE" });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe("AUTH_LAST_AUTH_METHOD");
    expect(h.identity.passkeys.size).toBe(1);
  });
});
