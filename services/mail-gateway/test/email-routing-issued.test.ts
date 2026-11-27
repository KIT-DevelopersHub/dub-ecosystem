import { describe, it, expect, vi, afterEach } from "vitest";
import { createApp } from "../src/app";
import { makeEnv } from "./helpers";
import type { Env } from "../src/env";
import { runScheduledSendDrain } from "../src/scheduled-send";

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

/** CF stub that answers the rules LIST (GET), single-rule GET (updateRule's fetch-before-PUT), and
 *  CREATE/PUT/DELETE (mutations) distinctly. */
function stubCf(opts: { list?: unknown[]; onCreate?: (body: unknown) => Response; mutate?: unknown; get?: unknown } = {}) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = (init.method ?? "GET").toUpperCase();
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, url, body });
      if (method === "GET") {
        // updateRule() fetches the current rule (a single-resource GET, url ends in
        // .../rules/{id}) before merging + PUTting — distinct from the list GET
        // (.../rules?per_page=...) used elsewhere.
        const isSingleRule = /\/email\/routing\/rules\/[^/?]+$/.test(url);
        if (isSingleRule) return ok(opts.get ?? opts.mutate ?? {});
        return ok(opts.list ?? []);
      }
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
  it("issues an address: creates a worker rule, audits success, QUEUES the confirmation mail (201)", async () => {
    const calls = stubCf({ list: [], onCreate: (body) => ok({ id: "r_new", ...(body as object), priority: 0 }) });
    const { env, sends, raw } = wiredEnv();
    const before = Date.now();
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/issued-addresses", { method: "POST", headers: adminHeaders(), body: JSON.stringify({ localPart: "team" }) }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      address: string;
      destination: string;
      enabled: boolean;
      confirmationEmailSent: boolean;
      confirmationEmailScheduledAt: string | null;
      suppressionCleared: boolean | null;
      createdAt: string;
    };
    expect(body).toMatchObject({ id: "r_new", address: "team@developershub.jp", destination: "mail-gateway (Worker)", enabled: true, confirmationEmailSent: true });
    expect(body.suppressionCleared).toBeNull(); // mock provider: no suppression list to look at
    expect(body.createdAt).not.toBe("");

    // The CF create call carried a literal to-matcher in our zone + a worker action.
    const create = calls.find((c) => c.method === "POST")!;
    expect(create.body).toMatchObject({
      matchers: [{ type: "literal", field: "to", value: "team@developershub.jp" }],
      actions: [{ type: "worker", value: ["dub-mail-gateway"] }],
    });
    expect(sends.audit.some((a) => (a.payload as { action?: string }).action === "mail.email_routing.address.issue" && (a.payload as { result?: string }).result === "success")).toBe(true);

    // Regression (2026-11-27): NOT sent inline — a mail that beats the new rule to the MX
    // hard-bounces and Resend suppresses the address for good. It is parked ~5 min out.
    expect(sends.notif.some((e) => (e as { name?: string }).name === "mail.message.sent")).toBe(false);
    const row = raw.prepare(`SELECT owner_user_id, to_json, subject, scheduled_at, status FROM mail_scheduled`).get() as {
      owner_user_id: string | null;
      to_json: string;
      subject: string;
      scheduled_at: string;
      status: string;
    };
    expect(row).toMatchObject({ owner_user_id: null, subject: "メールアドレスを発行しました", status: "scheduled" });
    expect(JSON.parse(row.to_json)).toEqual([{ email: "team@developershub.jp" }]);
    expect(row.scheduled_at).toBe(body.confirmationEmailScheduledAt);
    const delayMs = Date.parse(row.scheduled_at) - before;
    expect(delayMs).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
    expect(delayMs).toBeLessThanOrEqual(5 * 60_000 + 5000);

    // The drain sends it once due, marked auto-generated (system row).
    expect((await runScheduledSendDrain(env, Date.now())).sent).toBe(0);
    const later = await runScheduledSendDrain(env, Date.now() + 6 * 60_000);
    expect(later.sent).toBe(1);
    expect(sends.notif.some((e) => (e as { name?: string }).name === "mail.message.sent")).toBe(true);
    const log = raw.prepare(`SELECT to_json, owner_user_id FROM mail_send_log WHERE subject = 'メールアドレスを発行しました'`).get() as { to_json: string; owner_user_id: string | null };
    expect(JSON.parse(log.to_json)).toEqual([{ email: "team@developershub.jp" }]);
    expect(log.owner_user_id).toBeNull();
  });

  it("MAIL_ISSUE_CONFIRM_DELAY_MIN sets the wait (0 = next cron tick)", async () => {
    stubCf({ list: [], onCreate: (body) => ok({ id: "r_d", ...(body as object), priority: 0 }) });
    const { env } = wiredEnv({ MAIL_ISSUE_CONFIRM_DELAY_MIN: "0" } as Partial<Env>);
    const before = Date.now();
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/issued-addresses", { method: "POST", headers: adminHeaders(), body: JSON.stringify({ localPart: "quick" }) }),
      env,
    );
    const at = ((await res.json()) as { confirmationEmailScheduledAt: string }).confirmationEmailScheduledAt;
    expect(Date.parse(at) - before).toBeLessThan(5000);
  });

  it("re-issuing a previously bounced address clears its Resend suppression (audited, recorded)", async () => {
    const cfCalls = stubCf({ list: [], onCreate: (body) => ok({ id: "r_re", ...(body as object), priority: 0 }) });
    const cfFetch = globalThis.fetch as unknown as (url: string, init: RequestInit) => Promise<Response>;
    const resendCalls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (!url.startsWith("https://api.resend.com/")) return cfFetch(url, init);
        const method = (init.method ?? "GET").toUpperCase();
        resendCalls.push({ method, url });
        if (method === "GET") {
          return new Response(
            JSON.stringify({ object: "suppression", id: "sup_1", email: "back@developershub.jp", origin: "bounce", source_id: "em_1", created_at: "2026-11-27 10:48:14.9+00" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ object: "suppression", id: "sup_1", deleted: true }), { status: 200 });
      }),
    );
    const { env, sends, raw } = wiredEnv({ MAIL_OUTBOUND_PROVIDER: "resend", RESEND_API_KEY: "re_test" } as Partial<Env>);
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/issued-addresses", { method: "POST", headers: adminHeaders(), body: JSON.stringify({ localPart: "back" }) }),
      env,
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { suppressionCleared: boolean | null }).suppressionCleared).toBe(true);
    expect(cfCalls.some((c) => c.method === "POST")).toBe(true);
    expect(resendCalls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
    expect(resendCalls[1]!.url).toBe("https://api.resend.com/suppressions/back%40developershub.jp");
    expect(sends.audit.some((a) => (a.payload as { action?: string }).action === "mail.suppression.remove" && (a.payload as { result?: string }).result === "success")).toBe(true);
    const ev = raw.prepare(`SELECT event_type, recipient_key FROM mail_provider_event`).get() as { event_type: string; recipient_key: string };
    expect(ev).toEqual({ event_type: "dub.suppression_removed", recipient_key: "back@developershub.jp" });
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

  it("still issues (201) when the suppression list cannot be checked — best-effort, flag=null", async () => {
    // provider=resend with NO api key => no suppressions client; the issue and the queued
    // confirmation are unaffected.
    stubCf({ list: [], onCreate: (body) => ok({ id: "r_ok", ...(body as object), priority: 0 }) });
    const { env } = wiredEnv({ MAIL_OUTBOUND_PROVIDER: "resend", RESEND_API_KEY: undefined } as Partial<Env>);
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/issued-addresses", { method: "POST", headers: adminHeaders(), body: JSON.stringify({ localPart: "noconfirm" }) }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { confirmationEmailSent: boolean; suppressionCleared: boolean | null };
    expect(body).toMatchObject({ confirmationEmailSent: true, suppressionCleared: null });
  });

  it("still issues (201) when the confirmation cannot be queued — best-effort, flag=false", async () => {
    stubCf({ list: [], onCreate: (body) => ok({ id: "r_nq", ...(body as object), priority: 0 }) });
    const { env, raw } = wiredEnv();
    raw.exec("DROP TABLE mail_scheduled");
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/issued-addresses", { method: "POST", headers: adminHeaders(), body: JSON.stringify({ localPart: "noqueue" }) }),
      env,
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { confirmationEmailSent: boolean }).confirmationEmailSent).toBe(false);
  });
});

describe("issued-addresses — toggle & revoke", () => {
  it("PATCH disables an issued address and audits", async () => {
    const calls = stubCf({ get: workerRule("r1", "sales@developershub.jp"), mutate: { ...workerRule("r1", "sales@developershub.jp"), enabled: false } });
    const { env, sends } = wiredEnv();
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/issued-addresses/r1", { method: "PATCH", headers: adminHeaders(), body: JSON.stringify({ enabled: false }) }),
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);
    expect(sends.audit[0]!.payload).toMatchObject({ action: "mail.email_routing.address.update", result: "success", resourceId: "r1" });
    // Regression: Cloudflare's Email Routing Rules API has no PATCH verb — the update
    // operation must reach Cloudflare as PUT, or it fails 502 upstream (found via live
    // staging verification: every 有効/無効 toggle in the admin UI 502'd).
    const cfCall = calls.find((c) => c.url.includes("/email/routing/rules/r1") && c.method === "PUT");
    expect(cfCall).toBeDefined();
    // And CF's PUT replaces the whole rule — a body with only `enabled` 422s live
    // ("must have actions; matchers: must have matchers"), so the client must fetch
    // the current rule first and merge it into the PUT body (matchers/actions carried
    // over from the existing rule, not dropped).
    expect(cfCall!.body).toMatchObject({ enabled: false, matchers: expect.any(Array), actions: expect.any(Array) });
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

// api-gateway の参加届 onboard-account が呼ぶ s2s の双子 (INTERNAL)。
describe("issued-addresses — internal twins (onboard-account)", () => {
  const internalHeaders = { "content-type": "application/json", "x-dub-request-id": "req_int", "x-dub-internal": "1", "x-dub-user-id": "usr_hr" };

  it("issues over the internal route with the same rules as the external one", async () => {
    stubCf({ list: [], onCreate: (body) => ok({ id: "r_new", ...(body as object), priority: 0 }) });
    const { env } = wiredEnv();
    const res = await app.fetch(
      new Request("https://svc/internal/email-routing/issued-addresses", { method: "POST", headers: internalHeaders, body: JSON.stringify({ localPart: "taro.yamada" }) }),
      env,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "r_new", address: "taro.yamada@developershub.jp" });
  });

  it("refuses an already-issued address with 409", async () => {
    stubCf({ list: [workerRule("r1", "sales@developershub.jp")] });
    const { env } = wiredEnv();
    const res = await app.fetch(
      new Request("https://svc/internal/email-routing/issued-addresses", { method: "POST", headers: internalHeaders, body: JSON.stringify({ localPart: "sales" }) }),
      env,
    );
    expect(res.status).toBe(409);
  });

  it("revokes (rollback) by address: only an issued Worker rule, and a missing one is a no-op", async () => {
    const calls = stubCf({ list: [workerRule("r_new", "taro.yamada@developershub.jp")], mutate: { id: "r_new" } });
    const { env } = wiredEnv();
    const revoke = (address: string) =>
      app.fetch(new Request("https://svc/internal/email-routing/issued-addresses/revoke", { method: "POST", headers: internalHeaders, body: JSON.stringify({ address }) }), env);
    const res = await revoke("taro.yamada@developershub.jp");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true, id: "r_new" });
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/rules/r_new"))).toBe(true);
    const none = await revoke("someone.else@developershub.jp");
    expect(await none.json()).toEqual({ revoked: false });
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("lookup reports any literal rule for the address as taken (forwarding rules included)", async () => {
    stubCf({ list: [workerRule("r1", "sales@developershub.jp"), { id: "fw", enabled: true, matchers: [{ type: "literal", field: "to", value: "info@developershub.jp" }], actions: [{ type: "forward", value: ["ops@example.com"] }] }] });
    const { env } = wiredEnv();
    const lookup = async (address: string) =>
      (await (await app.fetch(new Request("https://svc/internal/email-routing/issued-addresses/lookup", { method: "POST", headers: internalHeaders, body: JSON.stringify({ address }) }), env)).json()) as { taken: boolean };
    expect(await lookup("sales@developershub.jp")).toEqual({ taken: true });
    expect(await lookup("info@developershub.jp")).toEqual({ taken: true });
    expect(await lookup("new.person@developershub.jp")).toEqual({ taken: false });
  });

  it("is unreachable without the internal marker", async () => {
    stubCf({ list: [] });
    const { env } = wiredEnv();
    const res = await app.fetch(
      new Request("https://svc/internal/email-routing/issued-addresses", { method: "POST", headers: adminHeaders(), body: JSON.stringify({ localPart: "x" }) }),
      env,
    );
    expect(res.status).toBe(403);
  });
});
