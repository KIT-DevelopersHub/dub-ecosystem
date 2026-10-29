// Resend delivery-problem webhook -> admin alert.
//
// Why: a recipient on Resend's suppression list is dropped SILENTLY (Resend still answers
// 200 to the send). admin@/archive@ sat there for weeks after a hard bounce. Resend reports
// it only through webhooks, so this module receives them and alerts admins.
//
// Path: Resend -> api-gateway `POST /api/v1/public/webhooks/resend` (PUBLIC, raw bytes
// forwarded verbatim) -> this Worker `POST /internal/webhooks/resend` (INTERNAL). The Svix
// signature is verified HERE over the exact body bytes, with RESEND_WEBHOOK_SECRET.
// Secret unset -> 503 (fail closed, logged; config-check reports it).
//
// Per event (svix-id = idempotency key; Resend reuses it on retry):
//   1. INSERT OR IGNORE into mail_provider_event (0019). Duplicate -> 200, no 2nd alert.
//   2. Correlate with mail_send_log via provider_message_id (= Resend email_id).
//   3. Alert: own-domain recipient -> always; external -> at most once per recipient set
//      per 24h. Channels mirror the canary (publishAudit + error log) plus an in-app
//      notification to admin roles via SVC_NOTIFICATION (when bound). No email channel:
//      an alert mail to admin@ would ride the very path that is failing.
import { publishAudit } from "@dub/events";
import { nowIso } from "@dub/db";
import type { DbClient } from "@dub/db";
import { createServiceClient, newRequestId, type RequestContext } from "@dub/http";
import { consoleSink } from "@dub/observability";
import { common, type notification } from "@dub/types";
import { SERVICE_NAME } from "./config";
import { buildAuditEnv, buildDb } from "./deps";
import type { Env } from "./env";

export const RESEND_ALERT_EVENTS = new Set([
  "email.bounced",
  "email.complained",
  "email.delivery_delayed",
  "email.failed",
  "email.suppressed",
]);
export const SVIX_TOLERANCE_SEC = 300;
export const EXTERNAL_THROTTLE_MS = 24 * 60 * 60 * 1000;
export const ALERT_ROLE_IDS = ["role_sys_admin", "role_sys_maintainer"];
export const ALERT_NOTIFY_TYPE = "mail.delivery_alert";
const DEFAULT_ZONE = "developershub.jp";

// ---------------------------------------------------------------- Svix signature

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** base64 HMAC-SHA256 of `${id}.${timestamp}.${body}` keyed by the decoded `whsec_` secret. */
export async function svixSign(secret: string, id: string, timestamp: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    b64ToBytes(secret.trim().replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
  const msg = new Uint8Array(prefix.length + body.length);
  msg.set(prefix, 0);
  msg.set(body, prefix.length);
  return bytesToB64(new Uint8Array(await crypto.subtle.sign("HMAC", key, msg)));
}

export type SvixResult = { ok: true; id: string } | { ok: false; reason: string };

/** Verify Svix headers over the raw body. `svix-signature` may carry several "v1,<b64>". */
export async function verifySvix(secret: string, headers: Headers, body: Uint8Array, nowMs: number = Date.now()): Promise<SvixResult> {
  const id = headers.get("svix-id");
  const ts = headers.get("svix-timestamp");
  const sig = headers.get("svix-signature");
  if (!id || !ts || !sig) return { ok: false, reason: "missing svix headers" };
  const tsNum = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || String(tsNum) !== ts.trim()) return { ok: false, reason: "malformed svix-timestamp" };
  if (Math.abs(Math.floor(nowMs / 1000) - tsNum) > SVIX_TOLERANCE_SEC) return { ok: false, reason: "timestamp outside tolerance" };
  let expected: string;
  try {
    expected = await svixSign(secret, id, ts.trim(), body);
  } catch {
    return { ok: false, reason: "unusable secret" };
  }
  const match = sig
    .split(" ")
    .map((p) => p.trim())
    .filter((p) => p.startsWith("v1,"))
    .some((p) => timingSafeEqual(p.slice(3), expected));
  return match ? { ok: true, id } : { ok: false, reason: "signature mismatch" };
}

// ---------------------------------------------------------------- payload -> alert

export interface ResendEvent {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    subject?: string;
    created_at?: string;
    bounce?: { message?: string; subType?: string; type?: string };
    suppressed?: { message?: string; type?: string };
    failed?: { reason?: string };
    [k: string]: unknown;
  };
}

/** Japanese one-line reason + the provider's raw text. */
export function describeReason(ev: ResendEvent): { label: string; raw: string | null } {
  const d = ev.data ?? {};
  switch (ev.type) {
    case "email.bounced": {
      const b = d.bounce ?? {};
      const raw = [b.type, b.subType, b.message].filter(Boolean).join(" / ") || null;
      if (b.subType === "Suppressed") return { label: "送信停止リスト（過去のハードバウンス）", raw };
      if (b.type === "Permanent") return { label: "宛先が存在しない（ハードバウンス）", raw };
      if (b.type === "Transient") return { label: "一時的な配送失敗（ソフトバウンス）", raw };
      return { label: "バウンス", raw };
    }
    case "email.suppressed":
      return { label: "送信停止リスト（Resend の Suppressions に登録済み・送信されていません）", raw: [d.suppressed?.type, d.suppressed?.message].filter(Boolean).join(" / ") || null };
    case "email.complained":
      return { label: "迷惑メール報告（受信者からの苦情）", raw: null };
    case "email.delivery_delayed":
      return { label: "配送遅延（相手サーバーが一時的に受け付けていません）", raw: null };
    case "email.failed":
      return { label: "送信失敗", raw: d.failed?.reason ?? null };
    default:
      return { label: ev.type ?? "unknown", raw: null };
  }
}

function recipientsOf(ev: ResendEvent): string[] {
  const to = ev.data?.to;
  const list = Array.isArray(to) ? to : typeof to === "string" ? [to] : [];
  return [...new Set(list.filter((s): s is string => typeof s === "string").map((s) => s.trim().toLowerCase()).filter(Boolean))].sort();
}

/** Own-domain (zone apex or a subdomain of it). */
export function isInternalAddress(addr: string, zone: string): boolean {
  const domain = addr.slice(addr.lastIndexOf("@") + 1).replace(/>$/, "").toLowerCase();
  const z = zone.toLowerCase();
  return domain === z || domain.endsWith(`.${z}`);
}

function fmtJst(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return iso ?? "不明";
  const d = new Date(t + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} JST`;
}

export interface AlertMessage {
  title: string;
  body: string;
}

export function buildAlertMessage(
  ev: ResendEvent,
  recipients: string[],
  internal: boolean,
  sendLog: { id: string; subject: string } | null,
): AlertMessage {
  const { label, raw } = describeReason(ev);
  const subject = sendLog?.subject ?? ev.data?.subject ?? "(不明)";
  const who = recipients.join(", ") || "(不明)";
  const title = `メールが届いていません: ${who}`.slice(0, 200);
  const lines = [
    `Resend が配送の問題を報告しました${internal ? "（自ドメイン宛て）" : ""}。`,
    `宛先: ${who}`,
    `イベント: ${ev.type}`,
    `理由: ${label}`,
    ...(raw ? [`詳細: ${raw}`] : []),
    `件名: ${subject}`,
    `日時: ${fmtJst(ev.created_at ?? ev.data?.created_at)}`,
    ...(sendLog ? [`送信ログ: ${sendLog.id}`] : []),
    `Resend email_id: ${ev.data?.email_id ?? "(不明)"}`,
    "",
    "対処: Cloudflare Email Routing の受け口（ルール / 転送先）を確認 → Resend の Suppressions から外す",
  ];
  return { title, body: lines.join("\n") };
}

// ---------------------------------------------------------------- handler

export interface WebhookOutcome {
  status: number;
  body: Record<string, unknown>;
}

export interface WebhookDeps {
  now?: () => number;
}

/** Handle one Resend webhook delivery. Never throws: the HTTP status tells Resend whether to retry. */
export async function handleResendWebhook(env: Env, headers: Headers, rawBody: Uint8Array, deps: WebhookDeps = {}): Promise<WebhookOutcome> {
  const now = deps.now ?? Date.now;
  const ctx: RequestContext = { requestId: newRequestId(), caller: SERVICE_NAME };
  const secret = env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) {
    log("error", "resend webhook: RESEND_WEBHOOK_SECRET is not set — rejecting (fail closed)", ctx, {});
    return { status: 503, body: { error: "MAIL_WEBHOOK_UNCONFIGURED" } };
  }
  const v = await verifySvix(secret, headers, rawBody, now());
  if (!v.ok) {
    log("warn", "resend webhook: signature verification failed", ctx, { reason: v.reason });
    return { status: 401, body: { error: "UNAUTHENTICATED" } };
  }
  let ev: ResendEvent;
  try {
    ev = JSON.parse(new TextDecoder().decode(rawBody)) as ResendEvent;
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  if (!ev || typeof ev.type !== "string" || !RESEND_ALERT_EVENTS.has(ev.type)) {
    return { status: 200, body: { ok: true, ignored: true } };
  }

  const db = buildDb(env, ctx.requestId);
  try {
    return await recordAndAlert(env, ctx, db, v.id, ev, now());
  } catch (err) {
    log("error", "resend webhook: processing failed", ctx, { svixId: v.id, error: err instanceof Error ? err.message : String(err) });
    return { status: 500, body: { error: "INTERNAL" } }; // Resend retries; svix-id keeps it idempotent
  }
}

async function recordAndAlert(env: Env, ctx: RequestContext, db: DbClient, svixId: string, ev: ResendEvent, nowMs: number): Promise<WebhookOutcome> {
  const recipients = recipientsOf(ev);
  const recipientKey = recipients.join(",");
  const zone = (env.CF_EMAIL_ROUTING_ZONE_NAME || DEFAULT_ZONE).trim();
  const internal = recipients.some((r) => isInternalAddress(r, zone));
  const emailId = typeof ev.data?.email_id === "string" ? ev.data.email_id : null;
  const sendLog = emailId
    ? await db.first<{ id: string; subject: string }>(`SELECT id, subject FROM mail_send_log WHERE provider_message_id = ? LIMIT 1`, emailId)
    : null;
  const { raw, label } = describeReason(ev);
  const createdAt = new Date(nowMs).toISOString();

  const ins = await db.run(
    `INSERT OR IGNORE INTO mail_provider_event (svix_id, provider, event_type, provider_message_id, send_log_id, recipients_json,
       recipient_key, internal, subject, reason, occurred_at, alerted, created_at)
     VALUES (?, 'resend', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    svixId,
    ev.type,
    emailId,
    sendLog?.id ?? null,
    JSON.stringify(recipients),
    recipientKey,
    internal ? 1 : 0,
    sendLog?.subject ?? ev.data?.subject ?? null,
    raw ?? label,
    ev.created_at ?? ev.data?.created_at ?? null,
    createdAt,
  );
  if ((ins.meta?.changes ?? 0) === 0) return { status: 200, body: { ok: true, duplicate: true } };

  if (!internal) {
    const recent = await db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM mail_provider_event WHERE recipient_key = ? AND alerted = 1 AND created_at > ?`,
      recipientKey,
      new Date(nowMs - EXTERNAL_THROTTLE_MS).toISOString(),
    );
    if ((recent?.c ?? 0) > 0) {
      log("warn", "resend webhook: external delivery problem (alert throttled)", ctx, { svixId, type: ev.type, recipientKey });
      return { status: 200, body: { ok: true, alerted: false, throttled: true } };
    }
  }

  await db.run(`UPDATE mail_provider_event SET alerted = 1 WHERE svix_id = ?`, svixId);
  const msg = buildAlertMessage(ev, recipients, internal, sendLog);
  await raiseAlert(env, ctx, svixId, ev, recipients, internal, sendLog?.id ?? null, msg);
  return { status: 200, body: { ok: true, alerted: true } };
}

async function raiseAlert(
  env: Env,
  ctx: RequestContext,
  svixId: string,
  ev: ResendEvent,
  recipients: string[],
  internal: boolean,
  sendLogId: string | null,
  msg: AlertMessage,
): Promise<void> {
  const details = { eventType: ev.type, recipients, internal, sendLogId, emailId: ev.data?.email_id ?? null, title: msg.title, body: msg.body };
  log("error", `mail-gateway: ALERT — ${msg.title}`, ctx, { svixId, ...details });
  // Same channel as the canary's mail.canary.alert.
  try {
    await publishAudit(buildAuditEnv(env), {
      action: "mail.delivery.alert",
      actorId: null,
      orgId: common.DUB_DEFAULT_ORG_ID,
      result: "failure",
      resourceType: "mail_provider_event",
      resourceId: svixId,
      details,
      requestId: ctx.requestId,
      occurredAt: nowIso(),
    });
  } catch (err) {
    log("error", "resend webhook: failed to publish audit", ctx, { error: err instanceof Error ? err.message : String(err) });
  }
  // In-app notification to admin roles (same role fan-out as feedback / usage-meter alerts).
  if (env.SVC_NOTIFICATION) {
    try {
      const client = createServiceClient(env.SVC_NOTIFICATION, { service: "notification", caller: SERVICE_NAME });
      const req: notification.NotifyRequest = {
        type: ALERT_NOTIFY_TYPE,
        recipientIds: [],
        recipientRoles: ALERT_ROLE_IDS,
        title: msg.title,
        body: msg.body,
        channels: ["in_app"],
        dedupKey: `mail-delivery:${svixId}`,
        resourceType: "mail_provider_event",
        resourceId: svixId,
      };
      await client.post(ctx, "/notify", req);
    } catch (err) {
      log("error", "resend webhook: in-app notify failed", ctx, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function log(level: "info" | "warn" | "error", message: string, ctx: RequestContext, fields: Record<string, unknown>): void {
  consoleSink({ level, message, service: SERVICE_NAME, requestId: ctx.requestId, fields });
}
