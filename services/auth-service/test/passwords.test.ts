import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword, verifyPassword, seedPasswordCredential } from "../src/passwords";
import { makeHarness, jsonInit } from "./helpers";

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

  it("invite-only: valid password but rejected identity -> 403 AUTH_USER_REJECTED", async () => {
    const h = makeHarness();
    await seed(h, "ghost@developershub.jp", "pw");
    h.identity.result = { status: "rejected", user: null };
    const app = buildApp(h.deps);
    const res = await app.request("/auth/password/login", jsonInit({ email: "ghost@developershub.jp", password: "pw" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AUTH_USER_REJECTED");
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
