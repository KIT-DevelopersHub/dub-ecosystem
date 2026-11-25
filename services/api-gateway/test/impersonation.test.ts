// Admin impersonation at the edge: start relay (cookie, no token in body), /me banner info,
// subject identity downstream, deny list for high-risk actions, and the audit tags.
import { describe, it, expect } from "vitest";
import type { auth, identity } from "@dub/types";
import { createApp } from "../src/app";
import { impersonationBlockReason, type ImpersonationAuditRecord } from "../src/impersonation";
import { fakeBinding, json, makeEnv, execCtx, errOf, type CapturedBinding } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };
const ADMIN = "usr_admin";
const MEMBER = "usr_member";
const IMP: auth.ImpersonationInfo = { actorId: ADMIN, subjectId: MEMBER, startedAt: 1_000, expiresAt: 3_601_000 };

function verifyAs(userId: string, impersonation: auth.ImpersonationInfo | null = null): auth.AuthVerifyResponse {
  return {
    valid: true,
    userId,
    session: { userId, client: "web", sessionExpiresAt: impersonation?.expiresAt ?? 9_999_999_999_000 },
    reason: null,
    ...(impersonation ? { impersonation } : {}),
  };
}

function authSvc(verify: auth.AuthVerifyResponse, onOther?: (req: Request, path: string) => Response): CapturedBinding {
  return fakeBinding((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/verify") return json(200, verify);
    return onOther ? onOther(req, path) : json(404, {});
  });
}

function identitySvc(perms: string[]): CapturedBinding {
  return fakeBinding(async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/authz/check") {
      const body = (await req.json()) as identity.AuthzCheckRequest;
      return json(200, {
        decisions: body.checks.map((q) => ({ allowed: perms.includes(q.permission), evaluatedAt: "2026-01-01T00:00:00Z", ttlSeconds: 60 })),
      });
    }
    if (path.endsWith("/permissions")) return json(200, { permissions: perms });
    const m = /^\/users\/([^/]+)$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      return json(200, { id, orgId: "org_devhub", displayName: id === ADMIN ? "管理 太郎" : "メンバー 花子", avatarUrl: null, email: `${id}@developershub.jp` });
    }
    return json(200, {});
  });
}

function appWithAudit() {
  const records: ImpersonationAuditRecord[] = [];
  const app = createApp({ ...NO_RL, impersonationAudit: async (_c, r) => void records.push(r) });
  return { app, records };
}

const cookie = { cookie: "dub_session=tok_admin_1234567890" };

describe("POST /api/v1/admin/users/:userId/impersonation", () => {
  it("forwards the admin's own token to auth-service, relays Set-Cookie, keeps the token out of the body", async () => {
    const auth = authSvc(verifyAs(ADMIN), (_req, path) =>
      path === `/internal/admin/users/${MEMBER}/impersonation`
        ? json(200, { impersonation: IMP, setCookie: "dub_session=tok_imp; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600" })
        : json(404, {}),
    );
    const env = makeEnv({ SVC_AUTH: auth.fetcher, SVC_IDENTITY: identitySvc(["identity:admin", "identity:impersonate"]).fetcher });
    const { app } = appWithAudit();
    const res = await app.request(`/api/v1/admin/users/${MEMBER}/impersonation`, { method: "POST", headers: cookie }, env, execCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("dub_session=tok_imp");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ impersonation: IMP });
    const fwd = auth.requests.find((r) => new URL(r.url).pathname.endsWith("/impersonation"))!;
    expect(fwd.headers.get("authorization")).toBe("Bearer tok_admin_1234567890");
    expect(fwd.headers.get("x-dub-internal")).toBeTruthy();
    expect(fwd.headers.get("x-dub-user-id")).toBe(ADMIN);
  });

  it("403 for an admin without identity:impersonate (identity:admin is not enough)", async () => {
    const auth = authSvc(verifyAs(ADMIN));
    const env = makeEnv({ SVC_AUTH: auth.fetcher, SVC_IDENTITY: identitySvc(["identity:admin"]).fetcher });
    const res = await appWithAudit().app.request(`/api/v1/admin/users/${MEMBER}/impersonation`, { method: "POST", headers: cookie }, env, execCtx);
    expect(res.status).toBe(403);
    expect(auth.requests.some((r) => new URL(r.url).pathname.endsWith("/impersonation"))).toBe(false);
  });

  it("a nested start from inside an impersonation is refused at the edge", async () => {
    // the subject holds no impersonate key, so the gate 403s before anything is forwarded
    const auth = authSvc(verifyAs(MEMBER, IMP));
    const env = makeEnv({ SVC_AUTH: auth.fetcher, SVC_IDENTITY: identitySvc(["identity:read"]).fetcher });
    const res = await appWithAudit().app.request(`/api/v1/admin/users/usr_other/impersonation`, { method: "POST", headers: cookie }, env, execCtx);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/me while impersonating", () => {
  it("returns the SUBJECT as user/permissions and names the real admin", async () => {
    const env = makeEnv({ SVC_AUTH: authSvc(verifyAs(MEMBER, IMP)).fetcher, SVC_IDENTITY: identitySvc(["identity:read", "app:members:view"]).fetcher });
    const res = await appWithAudit().app.request("/api/v1/me", { headers: cookie }, env, execCtx);
    expect(res.status).toBe(200);
    const me = (await res.json()) as { user: { id: string }; permissions: string[]; sessionExpiresAt: number; impersonation: { actor: { id: string; displayName: string }; expiresAt: number } };
    expect(me.user.id).toBe(MEMBER);
    expect(me.permissions).toEqual(["identity:read", "app:members:view"]);
    expect(me.impersonation.actor).toMatchObject({ id: ADMIN, displayName: "管理 太郎" });
    expect(me.impersonation.expiresAt).toBe(IMP.expiresAt);
  });

  it("no impersonation field for a normal session", async () => {
    const env = makeEnv({ SVC_AUTH: authSvc(verifyAs(ADMIN)).fetcher, SVC_IDENTITY: identitySvc([]).fetcher });
    const me = (await (await appWithAudit().app.request("/api/v1/me", { headers: cookie }, env, execCtx)).json()) as Record<string, unknown>;
    expect(me["impersonation"]).toBeUndefined();
  });
});

describe("proxied requests while impersonating", () => {
  it("are forwarded with the SUBJECT as x-dub-user-id, and mutations are audit-tagged with the admin", async () => {
    const tasks = fakeBinding(() => json(201, { id: "task_1" }));
    const env = makeEnv({ SVC_AUTH: authSvc(verifyAs(MEMBER, IMP)).fetcher, SVC_TASK: tasks.fetcher });
    const { app, records } = appWithAudit();
    const res = await app.request("/api/v1/tasks", { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: "{}" }, env, execCtx);
    expect(res.status).toBe(201);
    expect(tasks.requests[0]!.headers.get("x-dub-user-id")).toBe(MEMBER);
    expect(records).toEqual([
      expect.objectContaining({ action: "auth.impersonation.request", actorId: ADMIN, subjectId: MEMBER, result: "success", details: { method: "POST", path: "/api/v1/tasks", status: 201 } }),
    ]);
  });

  it("reads are not audit-tagged (only mutations)", async () => {
    const env = makeEnv({ SVC_AUTH: authSvc(verifyAs(MEMBER, IMP)).fetcher, SVC_TASK: fakeBinding(() => json(200, { items: [] })).fetcher });
    const { app, records } = appWithAudit();
    expect((await app.request("/api/v1/tasks", { headers: cookie }, env, execCtx)).status).toBe(200);
    expect(records).toEqual([]);
  });

  it("a normal (non-impersonated) mutation is not tagged", async () => {
    const env = makeEnv({ SVC_AUTH: authSvc(verifyAs(ADMIN)).fetcher, SVC_TASK: fakeBinding(() => json(201, {})).fetcher });
    const { app, records } = appWithAudit();
    await app.request("/api/v1/tasks", { method: "POST", headers: cookie, body: "{}" }, env, execCtx);
    expect(records).toEqual([]);
  });

  const blocked: Array<[string, string, string]> = [
    ["POST", "/api/v1/mail/outbox", "mail_send"],
    ["POST", "/api/v1/mail/scheduled", "mail_send"],
    ["PATCH", "/api/v1/mail/scheduled/sch_1", "mail_send"],
    ["PUT", "/api/v1/mail/forward", "mail_forwarding"],
    ["PATCH", "/api/v1/identity/users/usr_member", "identity_change"],
    ["POST", "/api/v1/identity/users/usr_member/roles", "identity_change"],
    ["DELETE", "/api/v1/identity/roles/role_x", "identity_change"],
    ["POST", "/api/v1/members/role-sync/backfill", "role_change"],
  ];
  for (const [method, path, reason] of blocked) {
    it(`${method} ${path} → 403 ${reason}, never forwarded, audited as blocked`, async () => {
      const downstream = fakeBinding(() => json(200, {}));
      const env = makeEnv({
        SVC_AUTH: authSvc(verifyAs(MEMBER, IMP)).fetcher,
        SVC_MAIL_GATEWAY: downstream.fetcher,
        SVC_IDENTITY: downstream.fetcher,
        SVC_MEMBER: downstream.fetcher,
      });
      const { app, records } = appWithAudit();
      const res = await app.request(path, { method, headers: { ...cookie, "content-type": "application/json" }, body: "{}" }, env, execCtx);
      expect(res.status).toBe(403);
      const err = await errOf(res);
      expect(err.code).toBe("IMPERSONATION_ACTION_BLOCKED");
      expect(err.details).toEqual({ reason });
      expect(downstream.requests).toHaveLength(0);
      expect(records).toEqual([expect.objectContaining({ action: "auth.impersonation.blocked", actorId: ADMIN, subjectId: MEMBER, result: "denied" })]);
    });
  }

  it("mail drafts / reads stay allowed (only sending is blocked)", async () => {
    const mail = fakeBinding(() => json(200, { items: [] }));
    const env = makeEnv({ SVC_AUTH: authSvc(verifyAs(MEMBER, IMP)).fetcher, SVC_MAIL_GATEWAY: mail.fetcher });
    const res = await appWithAudit().app.request("/api/v1/mail/messages", { headers: cookie }, env, execCtx);
    expect(res.status).toBe(200);
    expect(mail.requests).toHaveLength(1);
  });

  it("the same mail send is NOT blocked for a normal session", async () => {
    const mail = fakeBinding(() => json(202, { id: "m1" }));
    const env = makeEnv({ SVC_AUTH: authSvc(verifyAs(ADMIN)).fetcher, SVC_MAIL_GATEWAY: mail.fetcher });
    const res = await appWithAudit().app.request("/api/v1/mail/outbox", { method: "POST", headers: cookie, body: "{}" }, env, execCtx);
    expect(res.status).toBe(202);
  });
});

describe("gateway-owned high-risk routes while impersonating", () => {
  it("POST /api/v1/me/password → 403 (credential change as the member)", async () => {
    const auth = authSvc(verifyAs(MEMBER, IMP), () => json(200, { ok: true }));
    const env = makeEnv({ SVC_AUTH: auth.fetcher, SVC_IDENTITY: identitySvc([]).fetcher });
    const { app, records } = appWithAudit();
    const res = await app.request("/api/v1/me/password", { method: "POST", headers: cookie, body: JSON.stringify({ currentPassword: "a", newPassword: "bbbbbbbb" }) }, env, execCtx);
    expect(res.status).toBe(403);
    expect((await errOf(res)).code).toBe("IMPERSONATION_ACTION_BLOCKED");
    expect(auth.requests.some((r) => new URL(r.url).pathname === "/auth/password")).toBe(false);
    expect(records[0]).toMatchObject({ action: "auth.impersonation.blocked", details: { reason: "credential_change" } });
  });

  it("admin password view → 403 even if the member somehow held identity:admin", async () => {
    const env = makeEnv({ SVC_AUTH: authSvc(verifyAs(MEMBER, IMP)).fetcher, SVC_IDENTITY: identitySvc(["identity:admin"]).fetcher });
    const res = await appWithAudit().app.request(`/api/v1/admin/users/usr_x/password`, { headers: cookie }, env, execCtx);
    expect(res.status).toBe(403);
    expect((await errOf(res)).code).toBe("IMPERSONATION_ACTION_BLOCKED");
  });

  it("self profile edits remain allowed and are audit-tagged", async () => {
    const env = makeEnv({ SVC_AUTH: authSvc(verifyAs(MEMBER, IMP)).fetcher, SVC_IDENTITY: identitySvc([]).fetcher });
    const { app, records } = appWithAudit();
    const res = await app.request("/api/v1/me/profile", { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: JSON.stringify({ displayName: "x" }) }, env, execCtx);
    expect(res.status).toBeLessThan(400);
    expect(records[0]).toMatchObject({ action: "auth.impersonation.request", actorId: ADMIN });
  });
});

describe("impersonationBlockReason (pure)", () => {
  it("reads are never blocked except the admin surface", () => {
    expect(impersonationBlockReason("GET", "/api/v1/identity/users")).toBeNull();
    expect(impersonationBlockReason("GET", "/api/v1/mail/outbox")).toBeNull();
    expect(impersonationBlockReason("GET", "/api/v1/admin/users/u/password")).toBe("admin_surface");
  });
  it("does not over-match similarly named paths", () => {
    expect(impersonationBlockReason("POST", "/api/v1/mail/outboxes")).toBeNull();
    expect(impersonationBlockReason("POST", "/api/v1/me/password-hint")).toBeNull();
    expect(impersonationBlockReason("POST", "/api/v1/tasks")).toBeNull();
  });
});
