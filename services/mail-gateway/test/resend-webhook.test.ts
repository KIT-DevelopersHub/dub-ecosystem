import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import { createApp } from "../src/index";
import {
  EXTERNAL_THROTTLE_MS,
  buildAlertMessage,
  describeReason,
  handleResendWebhook,
  isInternalAddress,
  svixSign,
  verifySvix,
  type ResendEvent,
} from "../src/resend-webhook";
import { deliveryWebhookReadiness } from "../src/config-check";
import type { Env } from "../src/env";
import { makeEnv } from "./helpers";

const SECRET = `whsec_${btoa("test-signing-secret-0123456789")}`;
const NOW = Date.UTC(2026, 9, 29, 3, 0, 0);
const enc = (s: string) => new TextEncoder().encode(s);

function event(type: string, to: string[], extra: Record<string, unknown> = {}): ResendEvent {
  return {
    type,
    created_at: "2026-10-29T03:00:00.000Z",
    data: { email_id: "re_email_1", to, subject: "テスト件名", created_at: "2026-10-29T02:59:59.000Z", ...extra },
  };
}

async function signed(body: string, id = "msg_1", tsSec = Math.floor(NOW / 1000), secret = SECRET): Promise<Headers> {
  const sig = await svixSign(secret, id, String(tsSec), enc(body));
  return new Headers({ "svix-id": id, "svix-timestamp": String(tsSec), "svix-signature": `v1,${sig}`, "content-type": "application/json" });
}

function notifyRecorder(): { fetcher: Fetcher; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const fetcher = {
    async fetch(req: Request) {
      calls.push({ path: new URL(req.url).pathname, internal: req.headers.get("x-dub-internal"), body: await req.json() });
      return new Response(JSON.stringify({ notificationId: "n1", deduplicated: false }), { status: 202, headers: { "content-type": "application/json" } });
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function setup(over: Partial<Env> = {}) {
  const notif = notifyRecorder();
  const h = makeEnv({ RESEND_WEBHOOK_SECRET: SECRET, SVC_NOTIFICATION: notif.fetcher, ...over });
  const alerts = () => h.sends.audit.map((a) => a.payload.action).filter((a) => a === "mail.delivery.alert");
  const rows = () => h.raw.prepare(`SELECT * FROM mail_provider_event ORDER BY created_at`).all() as Record<string, unknown>[];
  return { ...h, notif, alerts, rows };
}

async function deliver(env: Env, ev: ResendEvent, id: string, at = NOW) {
  const body = JSON.stringify(ev);
  return handleResendWebhook(env, await signed(body, id, Math.floor(at / 1000)), enc(body), { now: () => at });
}

describe("Svix signature", () => {
  const body = JSON.stringify(event("email.bounced", ["x@example.com"]));

  it("accepts a valid signature (also among several v1 entries)", async () => {
    const h = await signed(body);
    expect(await verifySvix(SECRET, h, enc(body), NOW)).toEqual({ ok: true, id: "msg_1" });
    h.set("svix-signature", `v1,AAAA ${h.get("svix-signature")}`);
    expect((await verifySvix(SECRET, h, enc(body), NOW)).ok).toBe(true);
  });

  it("rejects a tampered body, a wrong secret and missing headers", async () => {
    const h = await signed(body);
    expect(await verifySvix(SECRET, h, enc(body + " "), NOW)).toMatchObject({ ok: false, reason: "signature mismatch" });
    const other = `whsec_${btoa("another-secret")}`;
    expect((await verifySvix(other, h, enc(body), NOW)).ok).toBe(false);
    expect(await verifySvix(SECRET, new Headers(), enc(body), NOW)).toMatchObject({ ok: false, reason: "missing svix headers" });
  });

  it("rejects a stale (or far-future) timestamp even when correctly signed", async () => {
    const stale = await signed(body, "msg_1", Math.floor(NOW / 1000) - 301);
    expect(await verifySvix(SECRET, stale, enc(body), NOW)).toMatchObject({ ok: false, reason: "timestamp outside tolerance" });
    const future = await signed(body, "msg_1", Math.floor(NOW / 1000) + 301);
    expect((await verifySvix(SECRET, future, enc(body), NOW)).ok).toBe(false);
  });

  it("handler: invalid signature -> 401 and nothing recorded", async () => {
    const { env, rows, alerts } = setup();
    const h = await signed(body);
    h.set("svix-signature", "v1,bm9wZQ==");
    const out = await handleResendWebhook(env, h, enc(body), { now: () => NOW });
    expect(out.status).toBe(401);
    expect(rows()).toHaveLength(0);
    expect(alerts()).toHaveLength(0);
  });

  it("handler: missing secret -> 503 (fail closed), nothing recorded", async () => {
    const { env, rows } = setup({ RESEND_WEBHOOK_SECRET: undefined });
    const out = await handleResendWebhook(env, await signed(body), enc(body), { now: () => NOW });
    expect(out).toEqual({ status: 503, body: { error: "MAIL_WEBHOOK_UNCONFIGURED" } });
    expect(rows()).toHaveLength(0);
  });
});

describe("Resend webhook -> admin alert", () => {
  it("internal recipient: records, correlates with the send log, audits + notifies admins (Japanese)", async () => {
    const s = setup();
    s.raw.prepare(
      `INSERT INTO mail_send_log (id, idempotency_key, req_hash, requester, to_json, subject, provider, provider_message_id, status, created_at, updated_at)
       VALUES ('maillog_1', 'k1', 'h', 'svc', '[]', '本来の件名', 'resend', 're_email_1', 'sent', ?, ?)`,
    ).run(new Date(NOW).toISOString(), new Date(NOW).toISOString());
    const ev = event("email.bounced", ["Admin@developershub.jp"], { bounce: { type: "Permanent", subType: "General", message: "Recipient not found" } });
    const out = await deliver(s.env, ev, "msg_int");
    expect(out).toEqual({ status: 200, body: { ok: true, alerted: true } });

    const [row] = s.rows();
    expect(row).toMatchObject({ svix_id: "msg_int", event_type: "email.bounced", send_log_id: "maillog_1", internal: 1, alerted: 1, subject: "本来の件名", recipient_key: "admin@developershub.jp" });
    expect(s.alerts()).toEqual(["mail.delivery.alert"]);

    expect(s.notif.calls).toHaveLength(1);
    const call = s.notif.calls[0] as { path: string; internal: string; body: Record<string, unknown> };
    expect(call.path).toBe("/notify");
    expect(call.internal).toBe("1");
    expect(call.body).toMatchObject({ type: "mail.delivery_alert", recipientRoles: ["role_sys_admin", "role_sys_maintainer"], channels: ["in_app"], dedupKey: "mail-delivery:msg_int" });
    const text = String(call.body.body);
    expect(String(call.body.title)).toContain("admin@developershub.jp");
    expect(text).toContain("宛先が存在しない");
    expect(text).toContain("件名: 本来の件名");
    expect(text).toContain("2026-10-29 12:00 JST");
    expect(text).toContain("Cloudflare Email Routing の受け口");
    expect(text).toContain("Resend の Suppressions から外す");
  });

  it("idempotent redelivery: the same svix-id is a 200 no-op (one row, one alert)", async () => {
    const s = setup();
    const ev = event("email.suppressed", ["archive@developershub.jp"], { suppressed: { type: "OnAccountSuppressionList" } });
    await deliver(s.env, ev, "msg_dup");
    const again = await deliver(s.env, ev, "msg_dup", NOW + 60_000);
    expect(again).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(s.rows()).toHaveLength(1);
    expect(s.alerts()).toHaveLength(1);
    expect(s.notif.calls).toHaveLength(1);
  });

  it("internal recipients always alert; external ones at most once per 24h", async () => {
    const s = setup();
    await deliver(s.env, event("email.bounced", ["admin@developershub.jp"]), "i1");
    await deliver(s.env, event("email.bounced", ["admin@developershub.jp"]), "i2", NOW + 1000);
    expect(s.alerts()).toHaveLength(2);

    expect((await deliver(s.env, event("email.bounced", ["user@example.com"]), "e1")).body).toMatchObject({ alerted: true });
    expect((await deliver(s.env, event("email.complained", ["user@example.com"]), "e2", NOW + 3600_000)).body).toMatchObject({ alerted: false, throttled: true });
    // a different external recipient is not throttled by the first
    expect((await deliver(s.env, event("email.bounced", ["other@example.com"]), "e3", NOW + 3600_000)).body).toMatchObject({ alerted: true });
    // after the window it alerts again
    expect((await deliver(s.env, event("email.bounced", ["user@example.com"]), "e4", NOW + EXTERNAL_THROTTLE_MS + 1000)).body).toMatchObject({ alerted: true });
    expect(s.alerts()).toHaveLength(5);
    expect(s.rows()).toHaveLength(6); // throttled event still recorded
  });

  it("uncorrelated event still alerts with the payload subject; non-alert events are ignored", async () => {
    const s = setup();
    await deliver(s.env, event("email.failed", ["admin@developershub.jp"], { email_id: "unknown", failed: { reason: "reached_daily_quota" } }), "f1");
    expect(s.rows()[0]).toMatchObject({ send_log_id: null, subject: "テスト件名", reason: "reached_daily_quota" });
    const ignored = await deliver(s.env, event("email.delivered", ["admin@developershub.jp"]), "d1");
    expect(ignored.body).toMatchObject({ ignored: true });
    expect(s.rows()).toHaveLength(1);
  });

  it("works without the notification binding (audit only)", async () => {
    const s = setup({ SVC_NOTIFICATION: undefined });
    const out = await deliver(s.env, event("email.bounced", ["admin@developershub.jp"]), "n1");
    expect(out.status).toBe(200);
    expect(s.alerts()).toHaveLength(1);
  });
});

describe("route + helpers", () => {
  it("POST /internal/webhooks/resend is INTERNAL and verifies the signature", async () => {
    const s = setup();
    const app = createApp();
    const body = JSON.stringify(event("email.bounced", ["admin@developershub.jp"]));
    const nowSig = await signed(body, "route_1", Math.floor(Date.now() / 1000));
    const hdr = (h: Headers, internal: boolean) => {
      const out = new Headers(h);
      out.set("x-dub-request-id", "r");
      if (internal) out.set("x-dub-internal", "1");
      return out;
    };
    const denied = await app.fetch(new Request("https://svc/internal/webhooks/resend", { method: "POST", headers: hdr(nowSig, false), body }), s.env);
    expect(denied.status).toBe(403);
    const ok = await app.fetch(new Request("https://svc/internal/webhooks/resend", { method: "POST", headers: hdr(nowSig, true), body }), s.env);
    expect(ok.status).toBe(200);
    expect(s.rows()).toHaveLength(1);
    const noSecret = setup({ RESEND_WEBHOOK_SECRET: undefined });
    const res503 = await app.fetch(new Request("https://svc/internal/webhooks/resend", { method: "POST", headers: hdr(nowSig, true), body }), noSecret.env);
    expect(res503.status).toBe(503);
  });

  it("classifies own-domain addresses and reasons", () => {
    expect(isInternalAddress("admin@developershub.jp", "developershub.jp")).toBe(true);
    expect(isInternalAddress("a@mail.developershub.jp", "developershub.jp")).toBe(true);
    expect(isInternalAddress("a@notdevelopershub.jp", "developershub.jp")).toBe(false);
    expect(describeReason(event("email.bounced", [], { bounce: { type: "Permanent", subType: "Suppressed" } })).label).toContain("送信停止リスト");
    expect(describeReason(event("email.suppressed", [])).label).toContain("送信停止リスト");
    expect(buildAlertMessage(event("email.delivery_delayed", ["a@example.com"]), ["a@example.com"], false, null).body).toContain("配送遅延");
  });

  it("config-check reports a missing secret / binding without echoing values", () => {
    expect(deliveryWebhookReadiness({} as Env)).toMatchObject({ secretPresent: false, inAppNotify: false });
    expect(deliveryWebhookReadiness({} as Env).issues.join(" ")).toContain("signing secret is not set");
    const r = deliveryWebhookReadiness({ RESEND_WEBHOOK_SECRET: SECRET, SVC_NOTIFICATION: {} as Fetcher } as Env);
    expect(r).toEqual({ secretPresent: true, inAppNotify: true, issues: [] });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});
