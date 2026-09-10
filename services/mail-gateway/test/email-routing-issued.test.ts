import { describe, it, expect, vi, afterEach } from "vitest";
import { createApp } from "../src/app";
import { makeEnv } from "./helpers";
import type { Env } from "../src/env";

const app = createApp();

// Issued RECEIVING addresses = zone-scoped routing rules forwarding to the mail Worker.
// This is the surface that actually makes an issued @developershub.jp address work AND
// sends a confirmation mail on issue. Auth + unconfigured posture mirror the admin suite.
function adminHeaders(over: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", "x-dub-request-id": "req_iss", "x-dub-user-id": "usr_admin", ...over };
}
function wiredEnv(over: Partial<Env> = {}) {
  return makeEnv({
    CF_EMAIL_ROUTING_TOKEN: "cf-secret",
    CF_EMAIL_ROUTING_ZONE_ID: "zone_1",
    CF_EMAIL_ROUTING_ACCOUNT_ID: "acc_1",
    CF_EMAIL_ROUTING_WORKER_NAME: "dub-mail-gateway",
    // makeEnv defaults MAIL_OUTBOUND_PROVIDER=mock, so the confirmation mail "sends" green.
    ...over,
  } as Partial<Env>);
}

function ok(result: unknown) {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status: 200 });
}

/** CF stub that answers the rules LIST (GET) and CREATE/PATCH/DELETE (mutations) distinctly. */
function stubCf(opts: { list?: unknown[]; onCreate?: (body: unknown) => Response; mutate?: unknown } = {}) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = (init.method ?? "GET").toUpperCase();
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, url, body });
      if (method === "GET") return ok(opts.list ?? []);
      if (method === "POST" && opts.onCreate) return opts.onCreate(body);
      return ok(opts.mutate ?? { id: "r1" });
    }),
  );
  return calls;
}

const workerRule = (id: string, address: string) => ({
  id,
  name: `dub-issued:${address.split("@")[0]}`,
  enabled: true,
  priority: 0,
  matchers: [{ type: "literal", field: "to", value: address }],
  actions: [{ type: "worker", value: ["dub-mail-gateway"] }],
});

afterEach(() => vi.unstubAllGlobals());

describe("issued-addresses — auth & config", () => {
  it("503 when CF token is absent", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/mail/admin/email-routing/issued-addresses", { headers: adminHeaders() }), env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MAIL_EMAIL_ROUTING_UNCONFIGURED");
  });

  it("401/403 without a session identity", async () => {
    const { env } = wiredEnv();
    const res = await app.fetch(new Request("https://svc/mail/admin/email-routing/issued-addresses", { headers: { "x-dub-request-id": "r" } }), env);
    expect([401, 403]).toContain(res.status);
  });
});

describe("issued-addresses — list", () => {
  it("maps zone-receiving rules to issued addresses (worker target shown as destination)", async () => {
    stubCf({ list: [workerRule("r1", "sales@developershub.jp"), { id: "catchall", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "drop" }] }] });
    const { env } = wiredEnv();
    const res = await app.fetch(new Request("https://svc/mail/admin/email-routing/issued-addresses", { headers: adminHeaders() }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; address: string; localPart: string; destination: string; enabled: boolean }>; nextCursor: null };
    expect(body.items).toHaveLength(1); // the catch-all/drop rule is not an issued address
    expect(body.items[0]).toMatchObject({ id: "r1", address: "sales@developershub.jp", localPart: "sales", destination: "mail-gateway (Worker)", enabled: true });
    expect(body.nextCursor).toBeNull();
  });
});

describe("issued-addresses — issue (create rule + confirmation mail)", () => {
  it("issues an address: creates a worker rule, audits success, sends a confirmation mail (201)", async () => {
    const calls = stubCf({ list: [], onCreate: (body) => ok({ id: "r_new", ...(body as object), priority: 0 }) });
    const { env, sends } = wiredEnv();
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/issued-addresses", { method: "POST", headers: adminHeaders(), body: JSON.stringify({ localPart: "team" }) }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; address: string; destination: string; enabled: boolean; confirmationEmailSent: boolean; createdAt: string };
    expect(body).toMatchObject({ id: "r_new", address: "team@developershub.jp", destination: "mail-gateway (Worker)", enabled: true, confirmationEmailSent: true });
    expect(body.createdAt).not.toBe("");

    // The CF create call carried a literal to-matcher in our zone + a worker action.
    const create = calls.find((c) => c.method === "POST")!;
    expect(create.body).toMatchObject({
      matchers: [{ type: "literal", field: "to", value: "team@developershub.jp" }],
      actions: [{ type: "worker", value: ["dub-mail-gateway"] }],
    });

    // Issue audit success + the confirmation mail's own send audit + a mail.message.sent event.
    expect(sends.audit.some((a) => (a.payload as { action?: string }).action === "mail.email_routing.address.issue" && (a.payload as { result?: string }).result === "success")).toBe(true);
    expect(sends.notif.some((e) => (e as { name?: string }).name === "mail.message.sent")).toBe(true);
  });

  it("rejects a duplicate address with 409 (no create call)", async () => {
    const calls = stubCf({ list: [workerRule("r1", "sales@developershub.jp")] });
    const { env } = wiredEnv();
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/issued-addresses", { method: "POST", headers: adminHeaders(), body: JSON.stringify({ localPart: "sales" }) }),
      env,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MAIL_EMAIL_ROUTING_CONFLICT");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("rejects a bad local part with 400 (no CF call, no audit)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { env, sends } = wiredEnv();
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/issued-addresses", { method: "POST", headers: adminHeaders(), body: JSON.stringify({ localPart: "Bad Local!" }) }),
      env,
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sends.audit).toHaveLength(0);
  });

  it("still issues (201) when the confirmation mail cannot be sent — best-effort, flag=false", async () => {
    // provider=resend with NO api key => loud stub throws => confirmation send fails, but
    // the rule was already created, so the issue must still succeed.
    stubCf({ list: [], onCreate: (body) => ok({ id: "r_ok", ...(body as object), priority: 0 }) });
    const { env } = wiredEnv({ MAIL_OUTBOUND_PROVIDER: "resend", RESEND_API_KEY: undefined } as Partial<Env>);
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/issued-addresses", { method: "POST", headers: adminHeaders(), body: JSON.stringify({ localPart: "noconfirm" }) }),
      env,
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { confirmationEmailSent: boolean }).confirmationEmailSent).toBe(false);
  });
});

describe("issued-addresses — toggle & revoke", () => {
  it("PATCH disables an issued address and audits", async () => {
    stubCf({ mutate: { ...workerRule("r1", "sales@developershub.jp"), enabled: false } });
    const { env, sends } = wiredEnv();
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/issued-addresses/r1", { method: "PATCH", headers: adminHeaders(), body: JSON.stringify({ enabled: false }) }),
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);
    expect(sends.audit[0]!.payload).toMatchObject({ action: "mail.email_routing.address.update", result: "success", resourceId: "r1" });
  });

  it("DELETE revokes an issued address and audits", async () => {
    stubCf({ mutate: { id: "r1" } });
    const { env, sends } = wiredEnv();
    const res = await app.fetch(new Request("https://svc/mail/admin/email-routing/issued-addresses/r1", { method: "DELETE", headers: adminHeaders() }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe("r1");
    expect(sends.audit[0]!.payload).toMatchObject({ action: "mail.email_routing.address.revoke", result: "success", resourceId: "r1" });
  });
});
