import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword, verifyPassword, seedPasswordCredential, setCredential, encryptSecret, decryptSecret, generatePassword } from "../src/passwords";
import { makeHarness, jsonInit, getInit, fakeUser, TEST_ENC_KEY } from "./helpers";

describe("password hashing (PBKDF2-SHA256)", () => {
  it("round-trips: the correct password verifies, a wrong one does not", async () => {
    const encoded = await hashPassword("Sup3r-secret!");
    expect(encoded.startsWith("pbkdf2$sha256$")).toBe(true);
    expect(encoded).not.toContain("Sup3r-secret!"); // plaintext never present
    expect(await verifyPassword("Sup3r-secret!", encoded)).toBe(true);
    expect(await verifyPassword("wrong", encoded)).toBe(false);
  });

  it("distinct salts: hashing the same password twice yields different encodings", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("rejects a tampered / malformed encoding without throwing", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$sha256$100000$bad$bad")).toBe(false);
  });
});

describe("POST /auth/password/login", () => {
  async function seed(h: ReturnType<typeof makeHarness>, email: string, password: string): Promise<void> {
    await seedPasswordCredential(h.deps.passwords, email, password);
  }

  it("valid credentials -> 200, Set-Cookie web session, verifiable token", async () => {
    const h = makeHarness();
    await seed(h, "admin@developershub.jp", "demo-admin-pw");
    // identity resolves the canonical active user (FakeIdentity default = existing)
    const app = buildApp(h.deps);
    const res = await app.request("/auth/password/login", jsonInit({ email: "admin@developershub.jp", password: "demo-admin-pw" }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("dub_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    const body = (await res.json()) as { token: string; session: { userId: string; client: string } };
    expect(body.token).toBeTruthy();
    expect(body.session.client).toBe("web");
    expect((await h.deps.sessions.verify(body.token)).valid).toBe(true);
    expect(h.audit.records.some((r) => r.action === "auth.session.login" && r.result === "success" && r.details?.["method"] === "password")).toBe(true);
  });

  it("is case-insensitive on the email", async () => {
    const h = makeHarness();
    await seed(h, "admin@developershub.jp", "pw");
    const app = buildApp(h.deps);
    const res = await app.request("/auth/password/login", jsonInit({ email: "ADMIN@DEVELOPERSHUB.JP", password: "pw" }));
    expect(res.status).toBe(200);
  });

  it("non-company domain (gmail) -> 403 AUTH_DOMAIN_NOT_ALLOWED, no credential work", async () => {
    const h = makeHarness();
    // Even a seeded credential on the wrong domain is rejected purely on the domain.
    await seed(h, "someone@gmail.com", "whatever");
    const app = buildApp(h.deps);
    const res = await app.request("/auth/password/login", jsonInit({ email: "someone@gmail.com", password: "whatever" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AUTH_DOMAIN_NOT_ALLOWED");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(h.audit.records.some((r) => r.result === "failure" && r.details?.["reason"] === "domain_not_allowed")).toBe(true);
  });

  it("allowed domain is configurable via ALLOWED_LOGIN_DOMAIN", async () => {
    const h = makeHarness({ ALLOWED_LOGIN_DOMAIN: "example.com" });
    await seed(h, "user@example.com", "pw");
    const app = buildApp(h.deps);
    const ok = await app.request("/auth/password/login", jsonInit({ email: "user@example.com", password: "pw" }));
    expect(ok.status).toBe(200);
    // the previous default domain is now rejected
    const rejected = await app.request("/auth/password/login", jsonInit({ email: "admin@developershub.jp", password: "pw" }));
    expect(rejected.status).toBe(403);
  });

  it("wrong password -> 401 AUTH_INVALID_CREDENTIALS", async () => {
    const h = makeHarness();
    await seed(h, "admin@developershub.jp", "right");
    const app = buildApp(h.deps);
    const res = await app.request("/auth/password/login", jsonInit({ email: "admin@developershub.jp", password: "wrong" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AUTH_INVALID_CREDENTIALS");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("unknown email -> 401 with the SAME code (no account enumeration)", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    const res = await app.request("/auth/password/login", jsonInit({ email: "nobody@developershub.jp", password: "whatever" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AUTH_INVALID_CREDENTIALS");
  });

  it("allowlist: email not on the active roster -> 403 AUTH_NOT_ON_ALLOWLIST (even with a valid credential)", async () => {
    const h = makeHarness();
    await seed(h, "ghost@developershub.jp", "pw");
    h.identity.lookupUser = null; // not on the roster
    const app = buildApp(h.deps);
    const res = await app.request("/auth/password/login", jsonInit({ email: "ghost@developershub.jp", password: "pw" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AUTH_NOT_ON_ALLOWLIST");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(h.audit.records.some((r) => r.result === "failure" && r.details?.["reason"] === "not_on_allowlist")).toBe(true);
  });

  it("allowlist: a non-active roster user (invited/disabled) -> 403 AUTH_NOT_ON_ALLOWLIST", async () => {
    const h = makeHarness();
    await seed(h, "invited@developershub.jp", "pw");
    h.identity.lookupUser = fakeUser("invited@developershub.jp", "Invited", { status: "invited" });
    const app = buildApp(h.deps);
    const res = await app.request("/auth/password/login", jsonInit({ email: "invited@developershub.jp", password: "pw" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AUTH_NOT_ON_ALLOWLIST");
  });

  it("lockout guard: active seed accounts (admin/maintainer/member) are NOT locked out by the allowlist", async () => {
    for (const email of ["admin@developershub.jp", "maintainer@developershub.jp", "member@developershub.jp"]) {
      const h = makeHarness();
      await seed(h, email, "pw");
      h.identity.lookupUser = fakeUser(email, "Seed", { status: "active" });
      const app = buildApp(h.deps);
      const res = await app.request("/auth/password/login", jsonInit({ email, password: "pw" }));
      expect(res.status).toBe(200);
    }
  });

  it("on-roster active user WITHOUT a credential (github-synced, no PW yet) -> 401, no session", async () => {
    const h = makeHarness();
    h.identity.lookupUser = fakeUser("synced@developershub.jp", "Synced", { status: "active" });
    const app = buildApp(h.deps);
    const res = await app.request("/auth/password/login", jsonInit({ email: "synced@developershub.jp", password: "anything" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AUTH_INVALID_CREDENTIALS");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("missing fields -> 400 VALIDATION_FAILED", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    const res = await app.request("/auth/password/login", jsonInit({ email: "a@b.c" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
  });

  it("rate limits repeated failures for the same email -> 429 RATE_LIMITED", async () => {
    const h = makeHarness({ PWLOGIN_MAX_FAILURES: "3" });
    await seed(h, "admin@developershub.jp", "right");
    const app = buildApp(h.deps);
    const attempt = () => app.request("/auth/password/login", jsonInit({ email: "admin@developershub.jp", password: "wrong" }));
    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
    // budget burned -> the next attempt is blocked (even if the password were right)
    const blocked = await app.request("/auth/password/login", jsonInit({ email: "admin@developershub.jp", password: "right" }));
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
  });
});

describe("reversible password encryption (AES-256-GCM)", () => {
  it("round-trips the plaintext and never embeds it in the ciphertext", async () => {
    const enc = await encryptSecret("Sup3r-secret!", TEST_ENC_KEY);
    expect(enc.startsWith("enc$v1$")).toBe(true);
    expect(enc).not.toContain("Sup3r-secret!");
    expect(await decryptSecret(enc, TEST_ENC_KEY)).toBe("Sup3r-secret!");
  });

  it("distinct IVs: encrypting the same plaintext twice yields different ciphertexts", async () => {
    const a = await encryptSecret("same", TEST_ENC_KEY);
    const b = await encryptSecret("same", TEST_ENC_KEY);
    expect(a).not.toBe(b);
    expect(await decryptSecret(b, TEST_ENC_KEY)).toBe("same");
  });

  it("a wrong key cannot decrypt (GCM auth tag fails)", async () => {
    const enc = await encryptSecret("secret", TEST_ENC_KEY);
    const wrongKey = btoa(String.fromCharCode(...Array.from({ length: 32 }, () => 0)));
    await expect(decryptSecret(enc, wrongKey)).rejects.toBeTruthy();
  });

  it("generatePassword produces a strong random string", () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).toHaveLength(20);
    expect(a).not.toBe(b);
  });
});

// ---- #5b self password change ------------------------------------------------
describe("POST /auth/password (self change)", () => {
  const USER_ID = "usr_self0001";
  const EMAIL = "self@developershub.jp";

  async function loggedIn(h: ReturnType<typeof makeHarness>): Promise<string> {
    await seedPasswordCredential(h.deps.passwords, EMAIL, "old-password");
    h.identity.lookupUser = fakeUser(EMAIL, "Self", { id: USER_ID });
    h.identity.users.set(USER_ID, fakeUser(EMAIL, "Self", { id: USER_ID }));
    const app = buildApp(h.deps);
    const login = await app.request("/auth/password/login", jsonInit({ email: EMAIL, password: "old-password" }));
    expect(login.status).toBe(200);
    return ((await login.json()) as { token: string }).token;
  }

  it("verifies the current password and rotates to the new one (bearer session)", async () => {
    const h = makeHarness();
    const token = await loggedIn(h);
    const app = buildApp(h.deps);
    const res = await app.request("/auth/password", jsonInit({ currentPassword: "old-password", newPassword: "brand-new-password" }, { bearer: token }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
    // old password no longer logs in; the new one does
    const stored = await h.deps.passwords.get(EMAIL);
    expect(await verifyPassword("brand-new-password", stored!.hash)).toBe(true);
    expect(await verifyPassword("old-password", stored!.hash)).toBe(false);
    expect(h.audit.records.some((r) => r.action === "auth.password.changed" && r.result === "success")).toBe(true);
  });

  it("rejects a wrong current password with 401 and leaves the credential unchanged", async () => {
    const h = makeHarness();
    const token = await loggedIn(h);
    const app = buildApp(h.deps);
    const res = await app.request("/auth/password", jsonInit({ currentPassword: "WRONG", newPassword: "brand-new-password" }, { bearer: token }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AUTH_INVALID_CREDENTIALS");
    const stored = await h.deps.passwords.get(EMAIL);
    expect(await verifyPassword("old-password", stored!.hash)).toBe(true);
  });

  it("rejects a too-short new password with 400 VALIDATION_FAILED", async () => {
    const h = makeHarness();
    const token = await loggedIn(h);
    const app = buildApp(h.deps);
    const res = await app.request("/auth/password", jsonInit({ currentPassword: "old-password", newPassword: "short" }, { bearer: token }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
  });

  it("requires a valid session (401 without one)", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    const res = await app.request("/auth/password", jsonInit({ currentPassword: "x", newPassword: "brand-new-password" }));
    expect(res.status).toBe(401);
  });
});

// ---- #5a admin set / re-issue initial password -------------------------------
describe("POST /internal/admin/users/:userId/password (admin set)", () => {
  const ADMIN = "usr_admin001";
  const TARGET = "usr_target01";
  const TARGET_EMAIL = "target@developershub.jp";

  function withAdmin(h: ReturnType<typeof makeHarness>): void {
    h.identity.admins.add(ADMIN);
    h.identity.users.set(TARGET, fakeUser(TARGET_EMAIL, "Target", { id: TARGET }));
  }

  it("admin sets a specified initial password; the user can then log in with it", async () => {
    const h = makeHarness();
    withAdmin(h);
    const app = buildApp(h.deps);
    const res = await app.request(`/internal/admin/users/${TARGET}/password`, jsonInit({ password: "issued-password" }, { internal: true, actor: ADMIN }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; password?: string }).toEqual({ ok: true }); // specified -> not echoed
    // credential now works for login (target is an active roster user)
    h.identity.lookupUser = fakeUser(TARGET_EMAIL, "Target", { id: TARGET });
    const login = await app.request("/auth/password/login", jsonInit({ email: TARGET_EMAIL, password: "issued-password" }));
    expect(login.status).toBe(200);
    expect(h.audit.records.some((r) => r.action === "auth.password.set" && r.resourceId === TARGET)).toBe(true);
  });

  it("generates a strong password and returns it once when none is supplied", async () => {
    const h = makeHarness();
    withAdmin(h);
    const app = buildApp(h.deps);
    const res = await app.request(`/internal/admin/users/${TARGET}/password`, jsonInit({}, { internal: true, actor: ADMIN }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; password?: string };
    expect(body.ok).toBe(true);
    expect(body.password).toBeTruthy();
    const stored = await h.deps.passwords.get(TARGET_EMAIL);
    expect(await verifyPassword(body.password!, stored!.hash)).toBe(true);
  });

  it("is forbidden for a non-admin actor (403)", async () => {
    const h = makeHarness();
    h.identity.users.set(TARGET, fakeUser(TARGET_EMAIL, "Target", { id: TARGET }));
    // actor NOT in admins set
    const app = buildApp(h.deps);
    const res = await app.request(`/internal/admin/users/${TARGET}/password`, jsonInit({ password: "issued-password" }, { internal: true, actor: "usr_random" }));
    expect(res.status).toBe(403);
  });

  it("requires the internal marker (403 without x-dub-internal)", async () => {
    const h = makeHarness();
    withAdmin(h);
    const app = buildApp(h.deps);
    const res = await app.request(`/internal/admin/users/${TARGET}/password`, jsonInit({ password: "issued-password" }, { actor: ADMIN }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AUTH_INTERNAL_FORBIDDEN");
  });

  it("404s for an unknown target user", async () => {
    const h = makeHarness();
    h.identity.admins.add(ADMIN);
    const app = buildApp(h.deps);
    const res = await app.request(`/internal/admin/users/usr_nope/password`, jsonInit({ password: "issued-password" }, { internal: true, actor: ADMIN }));
    expect(res.status).toBe(404);
  });
});

// ---- #5c admin view (decrypt) -----------------------------------------------
describe("GET /internal/admin/users/:userId/password (admin view)", () => {
  const ADMIN = "usr_admin001";
  const TARGET = "usr_target01";
  const TARGET_EMAIL = "target@developershub.jp";

  async function setup(h: ReturnType<typeof makeHarness>): Promise<void> {
    h.identity.admins.add(ADMIN);
    h.identity.users.set(TARGET, fakeUser(TARGET_EMAIL, "Target", { id: TARGET }));
    // admin issues the password so an encrypted copy exists
    const app = buildApp(h.deps);
    const res = await app.request(`/internal/admin/users/${TARGET}/password`, jsonInit({ password: "viewable-secret" }, { internal: true, actor: ADMIN }));
    expect(res.status).toBe(200);
  }

  it("admin views the decrypted password and the read is audited", async () => {
    const h = makeHarness();
    await setup(h);
    const app = buildApp(h.deps);
    const res = await app.request(`/internal/admin/users/${TARGET}/password`, getInit({ internal: true, actor: ADMIN }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; email: string; password: string };
    expect(body.password).toBe("viewable-secret");
    expect(body.userId).toBe(TARGET);
    expect(h.audit.records.some((r) => r.action === "auth.password.viewed" && r.actorId === ADMIN && r.resourceId === TARGET)).toBe(true);
  });

  it("is forbidden for a non-admin actor (403), and does NOT audit a view", async () => {
    const h = makeHarness();
    await setup(h);
    const app = buildApp(h.deps);
    const res = await app.request(`/internal/admin/users/${TARGET}/password`, getInit({ internal: true, actor: "usr_random" }));
    expect(res.status).toBe(403);
    expect(h.audit.records.some((r) => r.action === "auth.password.viewed")).toBe(false);
  });

  it("409 AUTH_PASSWORD_NOT_VIEWABLE when only a hash exists (no encrypted copy)", async () => {
    const h = makeHarness();
    h.identity.admins.add(ADMIN);
    h.identity.users.set(TARGET, fakeUser(TARGET_EMAIL, "Target", { id: TARGET }));
    // seeded credential (hash only, no enc)
    await seedPasswordCredential(h.deps.passwords, TARGET_EMAIL, "seed-only");
    const app = buildApp(h.deps);
    const res = await app.request(`/internal/admin/users/${TARGET}/password`, getInit({ internal: true, actor: ADMIN }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AUTH_PASSWORD_NOT_VIEWABLE");
  });

  it("without the server key configured, admin set stores no encrypted copy -> view is 409", async () => {
    const h = makeHarness({ PASSWORD_ENC_KEY: "" });
    h.identity.admins.add(ADMIN);
    h.identity.users.set(TARGET, fakeUser(TARGET_EMAIL, "Target", { id: TARGET }));
    const app = buildApp(h.deps);
    const set = await app.request(`/internal/admin/users/${TARGET}/password`, jsonInit({ password: "no-key-secret" }, { internal: true, actor: ADMIN }));
    expect(set.status).toBe(200);
    const view = await app.request(`/internal/admin/users/${TARGET}/password`, getInit({ internal: true, actor: ADMIN }));
    expect(view.status).toBe(409);
  });
});
