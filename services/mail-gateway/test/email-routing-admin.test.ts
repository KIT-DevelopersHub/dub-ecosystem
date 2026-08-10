import { describe, it, expect, vi, afterEach } from "vitest";
import { createApp } from "../src/app";
import { makeEnv, fakeIdentityFetcher } from "./helpers";
import type { Env } from "../src/env";

const app = createApp();

// mail:admin external routes need a trusted x-dub-user-id (requireAuth) + an allowing
// identity fetcher (requirePermission). CF_* wires the proxy; global fetch is stubbed.
function adminHeaders(over: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", "x-dub-request-id": "req_er", "x-dub-user-id": "usr_admin", ...over };
}
function wiredEnv(over: Partial<Env> = {}) {
  return makeEnv({
    CF_EMAIL_ROUTING_TOKEN: "cf-secret",
    CF_EMAIL_ROUTING_ZONE_ID: "zone_1",
    CF_EMAIL_ROUTING_ACCOUNT_ID: "acc_1",
    ...over,
  } as Partial<Env>);
}

function stubCf(handler: (url: string, init: RequestInit) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => handler(url, init)));
}
function ok(result: unknown) {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status: 200 });
}

afterEach(() => vi.unstubAllGlobals());

describe("email-routing admin — auth gating", () => {
  it("401/403 without a session identity", async () => {
    const { env } = wiredEnv();
    const res = await app.fetch(new Request("https://svc/mail/admin/email-routing/addresses", { headers: { "x-dub-request-id": "r" } }), env);
    expect([401, 403]).toContain(res.status);
  });

  it("403 when mail:admin is denied", async () => {
    const { env } = wiredEnv({ SVC_IDENTITY: fakeIdentityFetcher(false) });
    const res = await app.fetch(new Request("https://svc/mail/admin/email-routing/addresses", { headers: adminHeaders() }), env);
    expect(res.status).toBe(403);
  });
});

describe("email-routing admin — unconfigured (no token)", () => {
  it("503 MAIL_EMAIL_ROUTING_UNCONFIGURED when the token secret is absent", async () => {
    const { env } = makeEnv(); // no CF_* set
    const res = await app.fetch(new Request("https://svc/mail/admin/email-routing/addresses", { headers: adminHeaders() }), env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MAIL_EMAIL_ROUTING_UNCONFIGURED");
  });

  it("readiness endpoint reports emailRouting.configured=false without leaking a token", async () => {
    const { env } = makeEnv({ CF_EMAIL_ROUTING_TOKEN: "SECRET" } as Partial<Env>);
    const res = await app.fetch(new Request("https://svc/internal/health/ready", { headers: { "x-dub-internal": "1", "x-dub-request-id": "r" } }), env);
    const body = (await res.json()) as { emailRouting: { configured: boolean } };
    expect(body.emailRouting.configured).toBe(true);
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });
});

describe("email-routing admin — addresses CRUD", () => {
  it("GET lists addresses", async () => {
    stubCf(() => ok([{ id: "d1", email: "team@gmail.com", verified: "2026-01-01", created: "", modified: "" }]));
    const { env } = wiredEnv();
    const res = await app.fetch(new Request("https://svc/mail/admin/email-routing/addresses", { headers: adminHeaders() }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ email: string }> };
    expect(body.items[0]!.email).toBe("team@gmail.com");
  });

  it("POST creates an address (201) and writes a success audit record", async () => {
    stubCf(() => ok({ id: "d2", email: "new@gmail.com", verified: null, created: "", modified: "" }));
    const { env, sends } = wiredEnv();
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/addresses", { method: "POST", headers: adminHeaders(), body: JSON.stringify({ email: "new@gmail.com" }) }),
      env,
    );
    expect(res.status).toBe(201);
    expect(sends.audit).toHaveLength(1);
    expect(sends.audit[0]!.payload).toMatchObject({ action: "mail.email_routing.address.create", result: "success", resourceId: "new@gmail.com", actorId: "usr_admin" });
  });

  it("POST with a bad email is a 400 (no CF call, no audit)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { env, sends } = wiredEnv();
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/addresses", { method: "POST", headers: adminHeaders(), body: JSON.stringify({ email: "nope" }) }),
      env,
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sends.audit).toHaveLength(0);
  });

  it("DELETE removes an address (200) and audits", async () => {
    stubCf(() => ok({ id: "d3", email: "x@y.com", verified: null, created: "", modified: "" }));
    const { env, sends } = wiredEnv();
    const res = await app.fetch(new Request("https://svc/mail/admin/email-routing/addresses/d3", { method: "DELETE", headers: adminHeaders() }), env);
    expect(res.status).toBe(200);
    expect(sends.audit[0]!.payload).toMatchObject({ action: "mail.email_routing.address.delete", result: "success" });
  });
});

describe("email-routing admin — rules CRUD", () => {
  const validRule = {
    name: "sales",
    matchers: [{ type: "literal", field: "to", value: "sales@developershub.jp" }],
    actions: [{ type: "forward", value: ["me@gmail.com"] }],
  };

  it("POST creates a rule (201) and audits success", async () => {
    stubCf(() => ok({ id: "r1", ...validRule, enabled: true, priority: 0 }));
    const { env, sends } = wiredEnv();
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/rules", { method: "POST", headers: adminHeaders(), body: JSON.stringify(validRule) }),
      env,
    );
    expect(res.status).toBe(201);
    expect(sends.audit[0]!.payload).toMatchObject({ action: "mail.email_routing.rule.create", result: "success" });
  });

  it("POST an out-of-zone matcher is 400 (anti-spoof)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { env } = wiredEnv();
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/rules", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ ...validRule, matchers: [{ type: "literal", field: "to", value: "ceo@othercorp.com" }] }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PATCH updates a rule and audits", async () => {
    stubCf(() => ok({ id: "r1", ...validRule, enabled: false, priority: 0 }));
    const { env, sends } = wiredEnv();
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/rules/r1", { method: "PATCH", headers: adminHeaders(), body: JSON.stringify({ enabled: false }) }),
      env,
    );
    expect(res.status).toBe(200);
    expect(sends.audit[0]!.payload).toMatchObject({ action: "mail.email_routing.rule.update", result: "success", resourceId: "r1" });
  });

  it("DELETE removes a rule and audits", async () => {
    stubCf(() => ok({ id: "r1", ...validRule, enabled: false, priority: 0 }));
    const { env, sends } = wiredEnv();
    const res = await app.fetch(new Request("https://svc/mail/admin/email-routing/rules/r1", { method: "DELETE", headers: adminHeaders() }), env);
    expect(res.status).toBe(200);
    expect(sends.audit[0]!.payload).toMatchObject({ action: "mail.email_routing.rule.delete", result: "success" });
  });

  it("a CF upstream failure surfaces 502 and writes a failure audit record", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ message: "rule limit reached" }], messages: [], result: null }), { status: 403 })));
    const { env, sends } = wiredEnv();
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/rules", { method: "POST", headers: adminHeaders(), body: JSON.stringify(validRule) }),
      env,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MAIL_EMAIL_ROUTING_UPSTREAM");
    expect(sends.audit[0]!.payload).toMatchObject({ action: "mail.email_routing.rule.create", result: "failure" });
  });
});
