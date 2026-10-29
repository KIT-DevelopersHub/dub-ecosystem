// Production synthetic mail monitor ("canary"). Runs from the existing 5-minute cron (see
// index.ts scheduled()); no new trigger. Every MAIL_CANARY_INTERVAL_MIN (default 15) it
// sends a REAL mail through the normal send core (Resend) To=MAIL_CANARY_TO,
// Cc=MAIL_CANARY_CC with a unique token in the subject, then on later ticks looks the
// message up in mail_inbound per recipient until MAIL_CANARY_DEADLINE_MIN (default 10).
//
// OFF unless MAIL_CANARY_ENABLED="true" AND both addresses are set.
//
// Isolation: the canary is addressed ONLY to the two QA addresses, the archive auto-CC is
// suppressed, local delivery is off and the send is a system send (owner NULL), so it
// never reaches a member's inbox or Sent folder. Inbound copies resolve an owner only if a
// QA address is itself a roster user (keep them out of the roster).
//
// Health per probe:
//   - default:              some copy reached mail_inbound (to_ok OR cc_ok).
//   - MAIL_CANARY_EXPECT_CC="true": both to_ok AND cc_ok. Each envelope copy now has its own
//     mail_inbound_delivery row (0018), so both recipients are observable — turn this on
//     once that fix is deployed. cc_ok is recorded either way.
// Alerting (audit + error log): the 2nd consecutive failed probe raises `mail.canary.alert`;
// the first ok probe after an alerted streak raises `mail.canary.recovered`.
import { publishAudit } from "@dub/events";
import { newId, nowIso } from "@dub/db";
import type { DbClient } from "@dub/db";
import { newRequestId } from "@dub/http";
import type { RequestContext } from "@dub/http";
import { consoleSink } from "@dub/observability";
import { common, type mail } from "@dub/types";
import { SERVICE_NAME } from "./config";
import { buildAuditEnv, buildDb, buildSendDeps } from "./deps";
import { parseAddress } from "./mime";
import { sendMail } from "./send";
import type { Env } from "./env";

export const CANARY_SUBJECT_PREFIX = "[dub-canary]";
export const CANARY_ALERT_AFTER = 2; // consecutive failed probes before alerting
const DEFAULT_INTERVAL_MIN = 15;
const DEFAULT_DEADLINE_MIN = 10;
const MINUTE = 60_000;

export interface CanaryConfig {
  to: string;
  cc: string;
  intervalMin: number;
  deadlineMin: number;
  expectCc: boolean;
}

function intIn(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}

/** Effective config, or null when the canary is disabled (the default). */
export function canaryConfig(env: Env): CanaryConfig | null {
  if (env.MAIL_CANARY_ENABLED?.trim().toLowerCase() !== "true") return null;
  const to = env.MAIL_CANARY_TO?.trim().toLowerCase();
  const cc = env.MAIL_CANARY_CC?.trim().toLowerCase();
  if (!to || !cc || to === cc) return null;
  // The cron ticks every 5 minutes, so the interval is rounded down to a multiple of 5.
  const interval = intIn(env.MAIL_CANARY_INTERVAL_MIN, DEFAULT_INTERVAL_MIN, 5, 1440);
  return {
    to,
    cc,
    intervalMin: interval - (interval % 5),
    deadlineMin: intIn(env.MAIL_CANARY_DEADLINE_MIN, DEFAULT_DEADLINE_MIN, 1, 120),
    expectCc: env.MAIL_CANARY_EXPECT_CC?.trim().toLowerCase() === "true",
  };
}

/** Whether this cron tick is a send slot (minute-of-epoch divisible by the interval). */
export function isSendSlot(scheduledTime: number, intervalMin: number): boolean {
  return Math.floor(scheduledTime / MINUTE) % intervalMin === 0;
}

/** True for an inbound copy of our own canary (used to skip the archive forward). */
export function isCanaryInbound(env: Env, envelopeTo: string, subject: string | undefined): boolean {
  const cfg = canaryConfig(env);
  if (!cfg || !subject?.trim().startsWith(CANARY_SUBJECT_PREFIX)) return false;
  const rcpt = parseAddress(envelopeTo).email.trim().toLowerCase();
  return rcpt === cfg.to || rcpt === cfg.cc;
}

export interface ProbeRow {
  id: string;
  token: string;
  subject: string;
  message_id: string | null;
  to_address: string;
  cc_address: string;
  sent_at: string;
  send_ok: number;
  send_error: string | null;
  status: "pending" | "ok" | "failed";
  to_ok: number | null;
  cc_ok: number | null;
  to_latency_ms: number | null;
  cc_latency_ms: number | null;
  checked_at: string | null;
  notified: string | null;
}

export interface CanaryProbeView {
  id: string;
  token: string;
  messageId: string | null;
  to: string;
  cc: string;
  sentAt: string;
  sendOk: boolean;
  sendError: string | null;
  status: ProbeRow["status"];
  toOk: boolean | null;
  ccOk: boolean | null;
  toLatencyMs: number | null;
  ccLatencyMs: number | null;
  checkedAt: string | null;
  notified: string | null;
}

const bool = (v: number | null): boolean | null => (v === null ? null : v === 1);

export function toProbeView(r: ProbeRow): CanaryProbeView {
  return {
    id: r.id,
    token: r.token,
    messageId: r.message_id,
    to: r.to_address,
    cc: r.cc_address,
    sentAt: r.sent_at,
    sendOk: r.send_ok === 1,
    sendError: r.send_error,
    status: r.status,
    toOk: bool(r.to_ok),
    ccOk: bool(r.cc_ok),
    toLatencyMs: r.to_latency_ms,
    ccLatencyMs: r.cc_latency_ms,
    checkedAt: r.checked_at,
    notified: r.notified,
  };
}

export async function listProbes(db: DbClient, limit: number): Promise<ProbeRow[]> {
  return db.all<ProbeRow>(`SELECT * FROM mail_canary_probe ORDER BY sent_at DESC, id DESC LIMIT ?`, limit);
}

interface InboundHit {
  created_at: string;
  header_meta_json: string | null;
  /** Envelope recipient of this copy (mail_inbound_delivery, 0018). Wins over header_meta. */
  delivered_to?: string | null;
}

/** mail_inbound rows for a probe: by Message-ID (indexed) or by the exact subject token
 *  within the probe's window (Resend may replace our Message-ID). */
async function findInbound(db: DbClient, p: ProbeRow): Promise<InboundHit[]> {
  const byId = p.message_id
    ? await db.all<InboundHit & { id: string }>(`SELECT id, created_at, header_meta_json FROM mail_inbound WHERE message_id = ?`, p.message_id)
    : [];
  const since = new Date(Date.parse(p.sent_at) - MINUTE).toISOString();
  const bySubject = await db.all<InboundHit & { id: string; message_id: string }>(
    `SELECT id, message_id, created_at, header_meta_json FROM mail_inbound WHERE created_at >= ? AND subject = ?`,
    since,
    p.subject,
  );
  const rows = [...byId, ...bySubject.filter((r) => r.message_id !== p.message_id)];
  // One hit per envelope copy (each recipient's delivery); a body row with no delivery
  // rows (pre-0018 shape) falls back to its own header_meta deliveredTo.
  const hits: InboundHit[] = [];
  for (const r of rows) {
    const deliveries = await db.all<{ envelope_to: string; created_at: string }>(
      `SELECT envelope_to, created_at FROM mail_inbound_delivery WHERE inbound_id = ?`,
      r.id,
    );
    if (deliveries.length === 0) hits.push({ created_at: r.created_at, header_meta_json: r.header_meta_json });
    for (const d of deliveries) hits.push({ created_at: d.created_at, header_meta_json: null, delivered_to: d.envelope_to || null });
  }
  return hits;
}

function deliveredTo(hit: InboundHit): string | null {
  if (hit.delivered_to) return hit.delivered_to.trim().toLowerCase();
  if (!hit.header_meta_json) return null;
  try {
    const meta = JSON.parse(hit.header_meta_json) as mail.MailHeaderMeta;
    return meta.deliveredTo?.trim().toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** Per-recipient arrival: the copy whose envelope recipient is that address. A row with no
 *  recorded recipient (pre-0013 shape) counts for To. Latency = earliest ingest − sent_at. */
export function evaluateArrivals(p: ProbeRow, hits: InboundHit[]): { toMs: number | null; ccMs: number | null } {
  const sent = Date.parse(p.sent_at);
  let toMs: number | null = null;
  let ccMs: number | null = null;
  for (const h of hits) {
    const ms = Math.max(0, Date.parse(h.created_at) - sent);
    const rcpt = deliveredTo(h);
    if (rcpt === p.cc_address) ccMs = ccMs === null ? ms : Math.min(ccMs, ms);
    else if (rcpt === p.to_address || rcpt === null) toMs = toMs === null ? ms : Math.min(toMs, ms);
  }
  return { toMs, ccMs };
}

export interface CanaryTickResult {
  enabled: boolean;
  sent: boolean;
  finalized: number;
  alerts: number;
  recoveries: number;
}

/** One canary pass. Never throws (a monitor must not break the cron it rides on). */
export async function runCanary(env: Env, scheduledTime: number = Date.now(), now: number = Date.now()): Promise<CanaryTickResult> {
  const out: CanaryTickResult = { enabled: false, sent: false, finalized: 0, alerts: 0, recoveries: 0 };
  const cfg = canaryConfig(env);
  if (!cfg) return out;
  out.enabled = true;
  const ctx: RequestContext = { requestId: newRequestId(), caller: SERVICE_NAME };
  const db = buildDb(env, ctx.requestId);
  try {
    await checkPending(env, ctx, db, cfg, now, out);
    if (isSendSlot(scheduledTime, cfg.intervalMin)) out.sent = await sendProbe(env, ctx, db, cfg, now, out);
  } catch (err) {
    log("error", "mail-gateway canary: tick failed", ctx, { error: err instanceof Error ? err.message : String(err) });
  }
  return out;
}

async function checkPending(env: Env, ctx: RequestContext, db: DbClient, cfg: CanaryConfig, now: number, out: CanaryTickResult): Promise<void> {
  const pending = await db.all<ProbeRow>(`SELECT * FROM mail_canary_probe WHERE status = 'pending' ORDER BY sent_at ASC LIMIT 20`);
  for (const p of pending) {
    const { toMs, ccMs } = evaluateArrivals(p, await findInbound(db, p));
    const expired = now - Date.parse(p.sent_at) >= cfg.deadlineMin * MINUTE;
    if (!(toMs !== null && ccMs !== null) && !expired) continue; // keep waiting
    const healthy = cfg.expectCc ? toMs !== null && ccMs !== null : toMs !== null || ccMs !== null;
    await db.run(
      `UPDATE mail_canary_probe SET status = ?, to_ok = ?, cc_ok = ?, to_latency_ms = ?, cc_latency_ms = ?,
         checked_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
      healthy ? "ok" : "failed",
      toMs !== null ? 1 : 0,
      ccMs !== null ? 1 : 0,
      toMs,
      ccMs,
      new Date(now).toISOString(),
      nowIso(),
      p.id,
    );
    out.finalized++;
    await evaluateAlert(env, ctx, db, p.id, healthy, out);
  }
}

async function sendProbe(env: Env, ctx: RequestContext, db: DbClient, cfg: CanaryConfig, now: number, out: CanaryTickResult): Promise<boolean> {
  // Guard against a double-fired tick: at most one probe per interval.
  const recent = await db.first<{ c: number }>(
    `SELECT COUNT(*) AS c FROM mail_canary_probe WHERE sent_at > ?`,
    new Date(now - (cfg.intervalMin * MINUTE - 2 * MINUTE)).toISOString(),
  );
  if ((recent?.c ?? 0) > 0) return false;

  const token = crypto.randomUUID();
  const subject = `${CANARY_SUBJECT_PREFIX} ${token}`;
  const req: mail.SendMailRequest = {
    to: [{ email: cfg.to }],
    cc: [{ email: cfg.cc }],
    subject,
    textBody: `Dub メール外形監視の試験メールです（自動送信・返信不要）。\ntoken: ${token}\n`,
    loopHeaders: { "auto-submitted": "auto-generated" },
  };
  // System send: default From, no owner (no member's Sent folder), archive CC suppressed.
  const deps = buildSendDeps(env, ctx, undefined, undefined, null);
  deps.archiveCc = "";
  // The probe must prove the real provider -> MX -> Email Routing path: no local shortcut.
  delete deps.localDelivery;
  let messageId: string | null = null;
  let sendError: string | null = null;
  try {
    const { response } = await sendMail(deps, req, `canary:${token}`, `${SERVICE_NAME}:canary`);
    messageId = response.messageId;
  } catch (err) {
    sendError = String((err as { code?: string }).code ?? "MAIL_PROVIDER_UNAVAILABLE");
  }
  const id = newId("mailcan");
  const ts = nowIso();
  await db.run(
    `INSERT INTO mail_canary_probe (id, token, subject, message_id, to_address, cc_address, sent_at, send_ok,
       send_error, status, to_ok, cc_ok, checked_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    token,
    subject,
    messageId,
    cfg.to,
    cfg.cc,
    new Date(now).toISOString(),
    sendError ? 0 : 1,
    sendError,
    sendError ? "failed" : "pending",
    sendError ? 0 : null,
    sendError ? 0 : null,
    sendError ? new Date(now).toISOString() : null,
    ts,
    ts,
  );
  if (sendError) {
    out.finalized++;
    await evaluateAlert(env, ctx, db, id, false, out);
  }
  return true;
}

/** Streak bookkeeping over finalized probes (newest first). Alert exactly once when the
 *  failure streak reaches CANARY_ALERT_AFTER; announce recovery on the first ok probe
 *  after an alerted streak. */
async function evaluateAlert(env: Env, ctx: RequestContext, db: DbClient, probeId: string, healthy: boolean, out: CanaryTickResult): Promise<void> {
  const recent = await db.all<Pick<ProbeRow, "id" | "status" | "notified" | "send_error" | "to_ok" | "cc_ok">>(
    `SELECT id, status, notified, send_error, to_ok, cc_ok FROM mail_canary_probe WHERE status != 'pending'
     ORDER BY sent_at DESC, id DESC LIMIT 50`,
  );
  const idx = recent.findIndex((r) => r.id === probeId);
  if (idx < 0) return;
  const before = recent.slice(idx + 1);
  let notified: "alert" | "recovered" | null = null;
  if (!healthy) {
    let streak = 1;
    for (const r of before) {
      if (r.status !== "failed") break;
      streak++;
    }
    if (streak === CANARY_ALERT_AFTER) notified = "alert";
  } else {
    let streak = 0;
    let alerted = false;
    for (const r of before) {
      if (r.status !== "failed") break;
      streak++;
      if (r.notified === "alert") alerted = true;
    }
    if (alerted && streak >= CANARY_ALERT_AFTER) notified = "recovered";
  }
  if (!notified) return;
  await db.run(`UPDATE mail_canary_probe SET notified = ?, updated_at = ? WHERE id = ?`, notified, nowIso(), probeId);
  const self = recent[idx]!;
  const details = { sendError: self.send_error, toOk: self.to_ok === 1, ccOk: self.cc_ok === 1, consecutiveFailures: notified === "alert" ? CANARY_ALERT_AFTER : 0 };
  if (notified === "alert") out.alerts++;
  else out.recoveries++;
  log(notified === "alert" ? "error" : "info", notified === "alert" ? "mail-gateway canary: ALERT — synthetic mail failed twice in a row" : "mail-gateway canary: recovered", ctx, { probeId, ...details });
  try {
    await publishAudit(buildAuditEnv(env), {
      action: notified === "alert" ? "mail.canary.alert" : "mail.canary.recovered",
      actorId: null,
      orgId: common.DUB_DEFAULT_ORG_ID,
      result: notified === "alert" ? "failure" : "success",
      resourceType: "mail_canary_probe",
      resourceId: probeId,
      details,
      requestId: ctx.requestId,
      occurredAt: nowIso(),
    });
  } catch (err) {
    log("error", "mail-gateway canary: failed to publish audit", ctx, { error: err instanceof Error ? err.message : String(err) });
  }
}

function log(level: "info" | "warn" | "error", message: string, ctx: RequestContext, fields: Record<string, unknown>): void {
  consoleSink({ level, message, service: SERVICE_NAME, requestId: ctx.requestId, fields });
}
