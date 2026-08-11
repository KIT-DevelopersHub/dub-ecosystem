// auth-service HTTP surface (Hono). Built from injected Deps so it is fully
// testable without the Cloudflare runtime. Route table + guards follow the P0a
// design and P0b frozen decisions (themes 6 / 8 / 13).
//
// Google OAuth (web) has been fully removed: login is now email+password only,
// restricted to a single company domain (ALLOWED_LOGIN_DOMAIN, default
// developershub.jp). The mobile exchange route (/mobile/exchange) is a separate
// mobile-client track and is intentionally left untouched.
import { Hono } from "hono";
import { dubErrorHandler, errors, type FieldError } from "@dub/errors";
import { extractContext, type RequestContext } from "@dub/http";
import { HDR_INTERNAL, INTERNAL_HEADER_VALUE } from "@dub/observability";
import type { auth, identity } from "@dub/types";
import type { Deps } from "./deps";
import { authErrors } from "./errors";
import { verifyPassword, setCredential, decryptSecret, generatePassword } from "./passwords";

// ---- local response shapes (requests + SessionInfo are frozen in @dub/types) ----
type RefreshResponse = { session: auth.SessionInfo } | { token: string; session: auth.SessionInfo };
interface TokenSessionResponse {
  token: string;
  session: auth.SessionInfo;
}
interface OkResponse {
  ok: true;
}

function ctxOf(c: { req: { raw: Request } }): RequestContext {
  return extractContext(c.req.raw.headers, { allowGenerate: true });
}

function requireInternal(c: { req: { header: (n: string) => string | undefined } }): void {
  if (c.req.header(HDR_INTERNAL) !== INTERNAL_HEADER_VALUE) throw authErrors.internalForbidden();
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function buildSessionCookie(name: string, token: string, domain: string, maxAgeSec: number): string {
  // Host-only cookie when no domain configured (domain === ""): omit the Domain
  // attribute so the cookie binds to the serving host. Required on *.workers.dev,
  // where a shared-suffix Domain attribute is rejected by the browser.
  const parts = [`${name}=${token}`, "HttpOnly", "Secure", "SameSite=Lax"];
  if (domain) parts.push(`Domain=${domain}`);
  parts.push("Path=/", `Max-Age=${maxAgeSec}`);
  return parts.join("; ");
}

function clearSessionCookie(name: string, domain: string): string {
  const parts = [`${name}=`, "HttpOnly", "Secure", "SameSite=Lax"];
  if (domain) parts.push(`Domain=${domain}`);
  parts.push("Path=/", "Max-Age=0");
  return parts.join("; ");
}

/** Best-effort client IP for the password-login rate limiter (Cloudflare header). */
function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf;
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return "unknown";
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

/** Domain of a normalized email (part after the last '@'), or "" when malformed. */
function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1);
}

async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    const fe: FieldError = { field, reason: "required" };
    throw errors.validationFailed([fe]);
  }
  return value;
}

/** Resolve the identity user for a profile (invite-only provision). */
async function provisionOrThrow(
  deps: Deps,
  ctx: RequestContext,
  profile: { email: string; displayName: string },
): Promise<identity.IdentityUser> {
  const result = await deps.identity.provision(ctx, {
    email: profile.email,
    displayName: profile.displayName,
  });
  if (result.status === "rejected" || !result.user) throw authErrors.userRejected();
  return result.user;
}

export function buildApp(deps: Deps): Hono {
  const app = new Hono();
  app.onError(dubErrorHandler({ service: "auth-service" }));

  const { config } = deps;

  app.get("/health", (c) => c.json({ ok: true, service: "auth-service" }));

  // ---- POST /auth/password/login (public) ----
  // The ONLY interactive web login path (Google OAuth was removed). Access is
  // restricted to the identity-roster ALLOWLIST (theme #4): only emails that map to
  // an ACTIVE roster user may authenticate — not a whole email domain. identity-roster
  // stays the source of truth for who may log in and for the canonical user id + roles.
  // Credentials are verified against PBKDF2 hashes.
  app.post("/auth/password/login", async (c) => {
    const ctx = ctxOf(c);
    const body = await readJson<Partial<auth.AuthPasswordLoginRequest>>(c);
    const emailRaw = requireString(body.email, "email");
    const password = requireString(body.password, "password");
    const email = emailRaw.trim().toLowerCase();

    const ip = clientIp(c);
    const emailKey = `e:${email}`;
    const ipKey = `i:${ip}`;
    const { maxFailures, windowSec } = config.passwordLogin;
    const bumpFailure = async (): Promise<void> => {
      await deps.rateLimiter.hit(emailKey, windowSec);
      await deps.rateLimiter.hit(ipKey, windowSec);
    };

    // OPTIONAL domain filter: only applied when ALLOWED_LOGIN_DOMAIN is configured.
    // It is a coarse extra layer, never the sole gate (the roster allowlist below is
    // authoritative). The email domain is public info, so a distinct 403 leaks nothing.
    if (config.allowedLoginDomain && emailDomain(email) !== config.allowedLoginDomain) {
      await deps.audit.record({ action: "auth.session.login", actorId: null, result: "failure", requestId: ctx.requestId, details: { method: "password", reason: "domain_not_allowed" } });
      throw authErrors.domainNotAllowed();
    }

    // Soft brute-force guard: block once either the email or the client IP has
    // already burned its failure budget in the window (counters bumped only on a
    // failed/blocked attempt, so a stream of correct logins is never throttled).
    if ((await deps.rateLimiter.peek(emailKey)) >= maxFailures || (await deps.rateLimiter.peek(ipKey)) >= maxFailures) {
      await deps.audit.record({ action: "auth.session.login", actorId: null, result: "failure", requestId: ctx.requestId, details: { method: "password", reason: "rate_limited" } });
      throw errors.rateLimited(windowSec);
    }

    // Allowlist gate (theme #4): the email MUST resolve to an ACTIVE roster user.
    // Non-roster / invited / disabled emails are rejected (403) BEFORE any credential
    // work. A failed allowlist check bumps the IP counter to blunt roster enumeration.
    const { user } = await deps.identity.lookupByEmail(ctx, email);
    if (!user || user.status !== "active") {
      await deps.rateLimiter.hit(ipKey, windowSec);
      await deps.audit.record({ action: "auth.session.login", actorId: null, result: "failure", requestId: ctx.requestId, details: { method: "password", reason: "not_on_allowlist" } });
      throw authErrors.notOnAllowlist();
    }

    const cred = await deps.passwords.get(email);
    const ok = cred ? await verifyPassword(password, cred.hash) : false;
    if (!ok) {
      await bumpFailure();
      await deps.audit.record({ action: "auth.session.login", actorId: null, result: "failure", requestId: ctx.requestId, details: { method: "password", reason: "invalid_credentials" } });
      throw authErrors.invalidCredentials();
    }

    const created = await deps.sessions.create(user.id, "web");
    await deps.rateLimiter.reset(emailKey);
    await deps.audit.record({
      action: "auth.session.login",
      actorId: user.id,
      result: "success",
      requestId: ctx.requestId,
      details: { client: "web", method: "password" },
    });
    const maxAge = Math.ceil((created.absoluteExpiresAt - Date.now()) / 1000);
    c.header("set-cookie", buildSessionCookie(config.cookieName, created.token, config.cookieDomain, maxAge));
    const res: TokenSessionResponse = { token: created.token, session: created.session };
    return c.json(res);
  });

  // ---- POST /auth/password (public; self password change — #5b) ----
  // The logged-in user changes their OWN password: verify the current password, then
  // store a fresh PBKDF2 hash (+ encrypted copy when the server key is configured).
  app.post("/auth/password", async (c) => {
    const ctx = ctxOf(c);
    const bearer = bearerToken(c.req.header("authorization"));
    const cookieToken = readCookie(c.req.header("cookie"), config.cookieName);
    const token = bearer ?? cookieToken ?? "";
    const verified = await deps.sessions.verify(token);
    if (!verified.valid || !verified.userId) throw authErrors.invalidToken();
    const userId = verified.userId;

    const body = await readJson<{ currentPassword?: string; newPassword?: string }>(c);
    const currentPassword = requireString(body.currentPassword, "currentPassword");
    const newPassword = requireString(body.newPassword, "newPassword");
    if (newPassword.length < config.passwordMinLength) {
      throw errors.validationFailed([{ field: "newPassword", reason: "too_short", message: `min ${config.passwordMinLength} chars` }]);
    }

    const me = await deps.identity.getUser(ctx, userId);
    if (!me) throw authErrors.invalidToken();
    const email = me.email.trim().toLowerCase();

    const cred = await deps.passwords.get(email);
    const ok = cred ? await verifyPassword(currentPassword, cred.hash) : false;
    if (!ok) {
      await deps.audit.record({ action: "auth.password.changed", actorId: userId, result: "failure", requestId: ctx.requestId, details: { reason: "current_password_mismatch" } });
      throw authErrors.invalidCredentials();
    }

    await setCredential(deps.passwords, {
      email,
      password: newPassword,
      encKey: config.passwordEncKey || undefined,
      setBy: "self",
      mustChange: false,
    });
    await deps.audit.record({ action: "auth.password.changed", actorId: userId, result: "success", requestId: ctx.requestId, resourceType: "user", resourceId: userId });
    const res: OkResponse = { ok: true };
    return c.json(res);
  });

  // ---- POST /internal/admin/users/:userId/password (internal + identity:admin — #5a) ----
  // An admin sets or re-issues a user's initial password (e.g. the roster's
  // github-synced accounts that have no credential yet). Body: { password?, generate?,
  // mustChange? }. When no password is supplied (or generate=true) a strong random one
  // is generated and returned ONCE so the admin can hand it over.
  app.post("/internal/admin/users/:userId/password", async (c) => {
    requireInternal(c);
    const ctx = ctxOf(c);
    const actor = ctx.userId;
    if (!actor) throw errors.unauthenticated();
    if (!(await deps.identity.hasPermission(ctx, actor, "identity:admin"))) throw errors.forbidden("identity:admin required");

    const targetId = c.req.param("userId");
    const target = await deps.identity.getUser(ctx, targetId);
    if (!target) throw errors.notFound("user", targetId);

    const body = await readJson<{ password?: string; generate?: boolean; mustChange?: boolean }>(c).catch(() => ({}) as { password?: string; generate?: boolean; mustChange?: boolean });
    const supplied = typeof body.password === "string" && body.password.length > 0 ? body.password : "";
    const generated = supplied === "" || body.generate === true;
    let password = supplied;
    if (generated) {
      password = generatePassword();
    } else if (password.length < config.passwordMinLength) {
      throw errors.validationFailed([{ field: "password", reason: "too_short", message: `min ${config.passwordMinLength} chars` }]);
    }

    const email = target.email.trim().toLowerCase();
    await setCredential(deps.passwords, {
      email,
      password,
      encKey: config.passwordEncKey || undefined,
      setBy: actor,
      mustChange: body.mustChange ?? true,
    });
    await deps.audit.record({
      action: "auth.password.set",
      actorId: actor,
      result: "success",
      requestId: ctx.requestId,
      resourceType: "user",
      resourceId: targetId,
      details: { method: generated ? "generated" : "specified" },
    });
    const res = generated ? { ok: true as const, password } : { ok: true as const };
    return c.json(res);
  });

  // ---- GET /internal/admin/users/:userId/password (internal + identity:admin — #5c) ----
  // An admin views a user's current password (decision B, risk accepted). The plaintext
  // is NEVER stored: it is decrypted on demand from the AES-GCM copy under the server
  // key, and every view is audited (auth.password.viewed).
  app.get("/internal/admin/users/:userId/password", async (c) => {
    requireInternal(c);
    const ctx = ctxOf(c);
    const actor = ctx.userId;
    if (!actor) throw errors.unauthenticated();
    if (!(await deps.identity.hasPermission(ctx, actor, "identity:admin"))) throw errors.forbidden("identity:admin required");

    const targetId = c.req.param("userId");
    const target = await deps.identity.getUser(ctx, targetId);
    if (!target) throw errors.notFound("user", targetId);
    const email = target.email.trim().toLowerCase();

    const cred = await deps.passwords.get(email);
    if (!cred || !cred.enc) throw authErrors.passwordNotViewable();
    if (!config.passwordEncKey) throw authErrors.encKeyUnavailable();
    let password: string;
    try {
      password = await decryptSecret(cred.enc, config.passwordEncKey);
    } catch {
      throw authErrors.encKeyUnavailable();
    }
    // Audit BEFORE returning: the sensitive read is recorded even if the response is lost.
    await deps.audit.record({
      action: "auth.password.viewed",
      actorId: actor,
      result: "success",
      requestId: ctx.requestId,
      resourceType: "user",
      resourceId: targetId,
    });
    return c.json({ userId: targetId, email, password });
  });

  // ---- POST /verify (internal: gateway / MO3 only) ----
  app.post("/verify", async (c) => {
    requireInternal(c);
    const body = await readJson<Partial<auth.AuthVerifyRequest>>(c);
    const token = typeof body.token === "string" ? body.token : "";
    const result = await deps.sessions.verify(token);
    return c.json(result satisfies auth.AuthVerifyResponse);
  });

  // ---- POST /auth/refresh (public; cookie or bearer path — theme8) ----
  app.post("/auth/refresh", async (c) => {
    const ctx = ctxOf(c);
    const bearer = bearerToken(c.req.header("authorization"));
    const body = await readJson<Partial<auth.AuthRefreshRequest>>(c).catch(() => ({}) as Partial<auth.AuthRefreshRequest>);
    const bodyToken = typeof body.refreshToken === "string" ? body.refreshToken : null;
    const cookieToken = readCookie(c.req.header("cookie"), config.cookieName);
    const isBearerPath = Boolean(bearer || bodyToken);
    const token = bearer ?? bodyToken ?? cookieToken ?? "";

    const result = await deps.sessions.refresh(token);
    if ("error" in result) {
      if (result.error === "malformed") throw authErrors.invalidToken();
      throw authErrors.sessionRevoked();
    }
    await deps.audit.record({
      action: "auth.session.refresh",
      actorId: result.session.userId,
      result: "success",
      requestId: ctx.requestId,
      details: { path: isBearerPath ? "bearer" : "cookie" },
    });
    if (isBearerPath) {
      const res: RefreshResponse = { token: result.token, session: result.session };
      return c.json(res);
    }
    const maxAge = Math.ceil((result.absoluteExpiresAt - Date.now()) / 1000);
    c.header("set-cookie", buildSessionCookie(config.cookieName, result.token, config.cookieDomain, maxAge));
    const res: RefreshResponse = { session: result.session };
    return c.json(res);
  });

  // ---- POST /auth/logout (public; cookie or bearer) ----
  app.post("/auth/logout", async (c) => {
    const ctx = ctxOf(c);
    const bearer = bearerToken(c.req.header("authorization"));
    const body = await readJson<{ token?: string }>(c).catch(() => ({}) as { token?: string });
    const bodyToken = typeof body.token === "string" ? body.token : null;
    const cookieToken = readCookie(c.req.header("cookie"), config.cookieName);
    const isBearerPath = Boolean(bearer || bodyToken);
    const token = bearer ?? bodyToken ?? cookieToken ?? "";

    await deps.sessions.logout(token);
    await deps.audit.record({
      action: "auth.session.logout",
      actorId: ctx.userId ?? null,
      result: "success",
      requestId: ctx.requestId,
    });
    if (!isBearerPath) c.header("set-cookie", clearSessionCookie(config.cookieName, config.cookieDomain));
    const res: OkResponse = { ok: true };
    return c.json(res);
  });

  // ---- POST /auth/test-login (local/preview only; excluded in production — theme8) ----
  app.post("/auth/test-login", async (c) => {
    if (!config.testLoginEnabled) throw authErrors.testLoginDisabled();
    const ctx = ctxOf(c);
    const body = await readJson<Partial<auth.TestLoginRequest>>(c);
    const userId = requireString(body.userId, "userId");
    const created = await deps.sessions.create(userId, "web");
    await deps.audit.record({
      action: "auth.session.test_login",
      actorId: userId,
      result: "success",
      requestId: ctx.requestId,
    });
    const maxAge = Math.ceil((created.absoluteExpiresAt - Date.now()) / 1000);
    c.header("set-cookie", buildSessionCookie(config.cookieName, created.token, config.cookieDomain, maxAge));
    const res: TokenSessionResponse = { token: created.token, session: created.session };
    return c.json(res);
  });

  // ---- POST /mobile/exchange (internal: MO3 only — theme8) ----
  // Mobile-client login track (native Google sign-in via MO3). Intentionally kept:
  // the web-console Google removal does not touch the mobile exchange contract.
  app.post("/mobile/exchange", async (c) => {
    requireInternal(c);
    const ctx = ctxOf(c);
    const body = await readJson<Partial<auth.MobileExchangeRequest>>(c);
    const code = requireString(body.code, "code");
    const profile = await deps.oauth.exchangeMobileCode(code);
    const user = await provisionOrThrow(deps, ctx, profile);
    const created = await deps.sessions.create(user.id, "mobile");
    await deps.audit.record({
      action: "auth.session.login",
      actorId: user.id,
      result: "success",
      requestId: ctx.requestId,
      details: { client: "mobile" },
    });
    const res: TokenSessionResponse = { token: created.token, session: created.session };
    return c.json(res);
  });

  // ---- POST /internal/revoke-user (internal: identity-roster only) ----
  app.post("/internal/revoke-user", async (c) => {
    requireInternal(c);
    const ctx = ctxOf(c);
    const body = await readJson<{ userId?: string; reason?: string }>(c);
    const userId = requireString(body.userId, "userId");
    await deps.sessions.revokeUser(userId);
    await deps.audit.record({
      action: "auth.session.revoked",
      actorId: ctx.userId ?? null,
      result: "success",
      requestId: ctx.requestId,
      resourceType: "user",
      resourceId: userId,
      details: { reason: body.reason ?? null },
    });
    const res: OkResponse = { ok: true };
    return c.json(res);
  });

  return app;
}
