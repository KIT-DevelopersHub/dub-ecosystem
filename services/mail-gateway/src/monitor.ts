// Production mail monitor (#898). Turns check results into ONE alert per incident and ONE
// "recovered" notice, over channels that do not depend on mail:
//   - in-app notification to the 管理者向け audience (SVC_NOTIFICATION; push rides along)
//   - Slack incoming webhook (MAIL_ALERT_SLACK_WEBHOOK_URL, optional secret)
//   - audit `mail.monitor.alert` / `mail.monitor.recovered` + error log (always)
//
// Checks (all on the existing 5-minute cron, no new trigger):
//   send        canary probe accepted by the provider            (canary.ts)
//   receive     canary copy reached mail_inbound via Email Routing (canary.ts)
//   api         GET /mail/messages + GET /mail/threads/:id answer for a test identity
//   send_errors real sends failing in the last hour (mail_send_log, index range only)
//   heartbeat   the monitor itself ran; read by app-health-monitor (dead-man's switch)
//
// Rows-read budget: state lives in mail_monitor_state (one row per check, read and written
// by primary key). Nothing here scans a table.
//
// OFF unless MAIL_MONITOR_ENABLED="true" (needs migration 0029). Never throws.
import { publishAudit } from "@dub/events";
import { nowIso, type DbClient } from "@dub/db";
import { createServiceClient, newRequestId, type RequestContext } from "@dub/http";
import { consoleSink, HEADERS } from "@dub/observability";
import { common, type notification } from "@dub/types";
import { SERVICE_NAME } from "./config";
import { buildAuditEnv, buildDb } from "./deps";
import type { Env } from "./env";

export const CHECKS = ["send", "receive", "api", "send_errors"] as const;
export type CheckName = (typeof CHECKS)[number];
export type StateName = CheckName | "heartbeat";

export const CHECK_LABELS: Record<CheckName, string> = {
  send: "メール送信（試験メールの送信）",
  receive: "メール受信（Email Routing → mail-gateway）",
  api: "メール画面の API（一覧・スレッド）",
  send_errors: "メンバーのメール送信",
};

/** Consecutive failures before alerting. 2 = one blip is ignored. */
export const ALERT_AFTER = 2;
export const MONITOR_NOTIFY_TYPE = "mail.monitor_alert";
export const MONITOR_AUDIENCES: notification.ReceiveAudience[] = ["admin"];
export const RUNBOOK_PATH = "docs/runbooks/12-mail-incident.md";
const DEFAULT_INTERVAL_MIN = 15;
const SEND_ERROR_WINDOW_MIN = 60;
const DEFAULT_SEND_ERROR_MIN = 3;
const API_TIMEOUT_MS = 10_000;
const MINUTE = 60_000;

export interface MonitorConfig {
  intervalMin: number;
  apiUserId: string | null;
  sendErrorMin: number;
  slackWebhookUrl: string | null;
}

function intIn(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}

export function monitorConfig(env: Env): MonitorConfig | null {
  if (env.MAIL_MONITOR_ENABLED?.trim().toLowerCase() !== "true") return null;
  const interval = intIn(env.MAIL_MONITOR_INTERVAL_MIN, DEFAULT_INTERVAL_MIN, 5, 60);
  return {
    intervalMin: interval - (interval % 5),
    apiUserId: env.MAIL_MONITOR_USER_ID?.trim() || null,
    sendErrorMin: intIn(env.MAIL_MONITOR_SEND_ERROR_MIN, DEFAULT_SEND_ERROR_MIN, 1, 1000),
    slackWebhookUrl: env.MAIL_ALERT_SLACK_WEBHOOK_URL?.trim() || null,
  };
}

// ---------------------------------------------------------------- state machine (pure)

export interface StreakState {
  failStreak: number;
  alerting: boolean;
  incidentStartedAt: string | null;
}

export type Notice = "alert" | "recovered";

/** Next state after one result. Alerts exactly once when the streak reaches `threshold`;
 *  announces recovery on the first ok after an alert. A blip below the threshold is silent. */
export function decide(prev: StreakState | null, ok: boolean, at: string, threshold = ALERT_AFTER): StreakState & { notice: Notice | null } {
  const p = prev ?? { failStreak: 0, alerting: false, incidentStartedAt: null };
  if (ok) {
    return { failStreak: 0, alerting: false, incidentStartedAt: p.alerting ? p.incidentStartedAt : null, notice: p.alerting ? "recovered" : null };
  }
  const failStreak = p.failStreak + 1;
  const incidentStartedAt = p.failStreak === 0 ? at : (p.incidentStartedAt ?? at);
  const raise = !p.alerting && failStreak >= threshold;
  return { failStreak, alerting: p.alerting || raise, incidentStartedAt, notice: raise ? "alert" : null };
}

// ---------------------------------------------------------------- persistence

export interface StateRow {
  check_name: StateName;
  status: "ok" | "failing";
  fail_streak: number;
  alerting: number;
  incident_started_at: string | null;
  pending_notice: Notice | null;
  last_run_at: string;
  last_ok_at: string | null;
  last_detail: string | null;
  ref: string | null;
  updated_at: string;
}

export async function readState(db: DbClient, name: StateName): Promise<StateRow | null> {
  return db.first<StateRow>(`SELECT * FROM mail_monitor_state WHERE check_name = ?`, name);
}

export async function listStates(db: DbClient): Promise<StateRow[]> {
  // At most 5 rows by construction (one per check name).
  return db.all<StateRow>(`SELECT * FROM mail_monitor_state ORDER BY check_name`);
}

async function writeState(db: DbClient, row: StateRow): Promise<void> {
  await db.run(
    `INSERT INTO mail_monitor_state (check_name, status, fail_streak, alerting, incident_started_at, pending_notice,
       last_run_at, last_ok_at, last_detail, ref, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(check_name) DO UPDATE SET status = excluded.status, fail_streak = excluded.fail_streak,
       alerting = excluded.alerting, incident_started_at = excluded.incident_started_at,
       pending_notice = excluded.pending_notice, last_run_at = excluded.last_run_at,
       last_ok_at = excluded.last_ok_at, last_detail = excluded.last_detail, ref = excluded.ref,
       updated_at = excluded.updated_at`,
    row.check_name,
    row.status,
    row.fail_streak,
    row.alerting,
    row.incident_started_at,
    row.pending_notice,
    row.last_run_at,
    row.last_ok_at,
    row.last_detail,
    row.ref,
    row.updated_at,
  );
}

// ---------------------------------------------------------------- alert channels

export interface AlertMessage {
  check: CheckName;
  notice: Notice;
  title: string;
  body: string;
  dedupKey: string;
}

export interface Alerter {
  /** Deliver one notice. Resolves true when at least one human channel (in-app or Slack) took it. */
  deliver(msg: AlertMessage): Promise<boolean>;
}

function jst(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(Date.parse(iso) + 9 * 60 * MINUTE);
  return `${d.toISOString().slice(0, 16).replace("T", " ")} (JST)`;
}

export function buildAlertMessage(check: CheckName, notice: Notice, row: StateRow): AlertMessage {
  const label = CHECK_LABELS[check];
  const started = row.incident_started_at ?? row.last_run_at;
  if (notice === "alert") {
    return {
      check,
      notice,
      title: `⚠️ メールの障害: ${label}が失敗しています`,
      body: [
        `本番のメール監視が ${row.fail_streak} 回続けて失敗しました。`,
        ``,
        `対象: ${label}`,
        `詳細: ${row.last_detail ?? "-"}`,
        `失敗の開始: ${jst(started)}`,
        `最後に成功: ${jst(row.last_ok_at)}`,
        ``,
        `対応手順: ${RUNBOOK_PATH}`,
      ].join("\n"),
      dedupKey: `mail-monitor:${check}:${started}:alert`,
    };
  }
  return {
    check,
    notice,
    title: `✅ メールが復旧しました: ${label}`,
    body: [`本番のメール監視で「${label}」の成功を確認しました。`, ``, `失敗の開始: ${jst(started)}`, `復旧: ${jst(row.last_run_at)}`].join("\n"),
    dedupKey: `mail-monitor:${check}:${started}:recovered`,
  };
}

export function createAlerter(env: Env, cfg: MonitorConfig, ctx: RequestContext, fetchImpl: typeof fetch = fetch): Alerter {
  return {
    async deliver(msg) {
      let delivered = false;
      if (env.SVC_NOTIFICATION) {
        try {
          const client = createServiceClient(env.SVC_NOTIFICATION, { service: "notification", caller: SERVICE_NAME });
          const req: notification.NotifyRequest = {
            type: MONITOR_NOTIFY_TYPE,
            recipientIds: [],
            recipientAudiences: MONITOR_AUDIENCES,
            title: msg.title,
            body: msg.body,
            channels: ["in_app"],
            dedupKey: msg.dedupKey,
            resourceType: "mail_monitor",
            resourceId: msg.check,
          };
          await client.post(ctx, "/notify", req);
          delivered = true;
        } catch (err) {
          log("error", "mail monitor: in-app notify failed", ctx, { check: msg.check, error: errText(err) });
        }
      }
      if (cfg.slackWebhookUrl) {
        try {
          const res = await fetchImpl(cfg.slackWebhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: `*${msg.title}*\n${msg.body}` }),
          });
          if (res.ok) delivered = true;
          else log("error", "mail monitor: slack webhook rejected", ctx, { check: msg.check, status: res.status });
        } catch (err) {
          log("error", "mail monitor: slack webhook failed", ctx, { check: msg.check, error: errText(err) });
        }
      }
      try {
        await publishAudit(buildAuditEnv(env), {
          action: msg.notice === "alert" ? "mail.monitor.alert" : "mail.monitor.recovered",
          actorId: null,
          orgId: common.DUB_DEFAULT_ORG_ID,
          result: msg.notice === "alert" ? "failure" : "success",
          resourceType: "mail_monitor",
          resourceId: msg.check,
          details: { title: msg.title, dedupKey: msg.dedupKey, delivered },
          requestId: ctx.requestId,
          occurredAt: nowIso(),
        });
      } catch (err) {
        log("error", "mail monitor: audit failed", ctx, { error: errText(err) });
      }
      log(msg.notice === "alert" ? "error" : "info", `mail monitor: ${msg.title}`, ctx, { check: msg.check, delivered });
      return delivered;
    },
  };
}

// ---------------------------------------------------------------- recording

export interface CheckResult {
  ok: boolean;
  detail: string;
  /** Kept when undefined (the previous ref survives a failure). */
  ref?: string | null;
}

export interface MonitorDeps {
  db: DbClient;
  alerter: Alerter;
}

/** Record one result: 1 PK read + 1 upsert, plus a notice when the incident state flips.
 *  An undelivered notice stays in pending_notice and is retried on the next result. */
export async function recordCheck(deps: MonitorDeps, check: CheckName, result: CheckResult, now: number): Promise<Notice | null> {
  const at = new Date(now).toISOString();
  const prev = await readState(deps.db, check);
  const next = decide(
    prev ? { failStreak: prev.fail_streak, alerting: prev.alerting === 1, incidentStartedAt: prev.incident_started_at } : null,
    result.ok,
    at,
  );
  const row: StateRow = {
    check_name: check,
    status: result.ok ? "ok" : "failing",
    fail_streak: next.failStreak,
    alerting: next.alerting ? 1 : 0,
    // A carried (undelivered) notice keeps its incident start so the retry reuses its dedup key.
    incident_started_at: next.incidentStartedAt ?? (!next.notice && prev?.pending_notice ? prev.incident_started_at : null),
    pending_notice: next.notice ?? prev?.pending_notice ?? null,
    last_run_at: at,
    last_ok_at: result.ok ? at : (prev?.last_ok_at ?? null),
    last_detail: result.detail.slice(0, 500),
    ref: result.ref === undefined ? (prev?.ref ?? null) : result.ref,
    updated_at: nowIso(),
  };
  if (row.pending_notice) {
    const delivered = await deps.alerter.deliver(buildAlertMessage(check, row.pending_notice, row));
    if (delivered) row.pending_notice = null;
  }
  // After a recovery the incident is closed: drop its start so the next one gets a new key.
  if (!row.alerting && row.pending_notice === null && result.ok) row.incident_started_at = null;
  await writeState(deps.db, row);
  return next.notice;
}

/** Monitor deps for the cron, or null when the monitor is off. */
export function buildMonitorDeps(env: Env, ctx: RequestContext): MonitorDeps | null {
  const cfg = monitorConfig(env);
  if (!cfg) return null;
  return { db: buildDb(env, ctx.requestId), alerter: createAlerter(env, cfg, ctx) };
}

/** Best-effort record from the canary (never throws). */
export async function recordFromCanary(env: Env, check: CheckName, result: CheckResult, now: number): Promise<void> {
  const ctx: RequestContext = { requestId: newRequestId(), caller: SERVICE_NAME };
  try {
    const deps = buildMonitorDeps(env, ctx);
    if (deps) await recordCheck(deps, check, result, now);
  } catch (err) {
    log("error", "mail monitor: record failed", ctx, { check, error: errText(err) });
  }
}

// ---------------------------------------------------------------- checks

/** Real sends failing in the last hour. Index range on (status, created_at) only. */
export async function checkSendErrors(db: DbClient, cfg: MonitorConfig, now: number): Promise<CheckResult> {
  const since = new Date(now - SEND_ERROR_WINDOW_MIN * MINUTE).toISOString();
  const failed = (await db.first<{ c: number }>(`SELECT COUNT(*) AS c FROM mail_send_log WHERE status = 'failed' AND created_at >= ?`, since))?.c ?? 0;
  const sent = (await db.first<{ c: number }>(`SELECT COUNT(*) AS c FROM mail_send_log WHERE status = 'sent' AND created_at >= ?`, since))?.c ?? 0;
  const ok = !(failed >= cfg.sendErrorMin && failed >= sent);
  return { ok, detail: `直近${SEND_ERROR_WINDOW_MIN}分: 送信済み ${sent} 件 / 失敗 ${failed} 件` };
}

export interface AppFetcher {
  fetch(req: Request, env: Env): Response | Promise<Response>;
}

async function timedAppFetch(app: AppFetcher, env: Env, path: string, userId: string, requestId: string): Promise<{ status: number; body: unknown; ms: number }> {
  const started = Date.now();
  const req = new Request(`https://${SERVICE_NAME}${path}`, {
    headers: { [HEADERS.userId]: userId, [HEADERS.requestId]: requestId, [HEADERS.caller]: `${SERVICE_NAME}:monitor` },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${API_TIMEOUT_MS}ms`)), API_TIMEOUT_MS);
  });
  try {
    const res = await Promise.race([Promise.resolve(app.fetch(req, env)), timeout]);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body, ms: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The screen's read path, run in-process under the test identity: the same policy gate
 *  (identity /authz/check), scope resolution, D1 queries and serialization as a real
 *  request. List = newest 5 (PK order, ~6 rows read); thread = the last canary's thread. */
export async function checkApi(app: AppFetcher, env: Env, userId: string, threadId: string | null, requestId: string): Promise<CheckResult> {
  try {
    const list = await timedAppFetch(app, env, "/mail/messages?limit=5", userId, requestId);
    const items = (list.body as { items?: unknown } | null)?.items;
    if (list.status !== 200 || !Array.isArray(items)) return { ok: false, detail: `一覧 GET /mail/messages が HTTP ${list.status}` };
    if (!threadId) return { ok: true, detail: `一覧 ${list.ms}ms（スレッドは試験メール未着のため未確認）` };
    const thread = await timedAppFetch(app, env, `/mail/threads/${encodeURIComponent(threadId)}`, userId, requestId);
    const messages = (thread.body as { messages?: { subject?: string }[] } | null)?.messages;
    if (thread.status !== 200 || !Array.isArray(messages)) return { ok: false, detail: `スレッド GET /mail/threads/:id が HTTP ${thread.status}` };
    if (!messages.some((m) => typeof m.subject === "string" && m.subject.includes("[dub-canary]"))) {
      return { ok: false, detail: "スレッドに試験メールが表示されない" };
    }
    return { ok: true, detail: `一覧 ${list.ms}ms / スレッド ${thread.ms}ms` };
  } catch (err) {
    return { ok: false, detail: `API 呼び出しで例外: ${errText(err)}` };
  }
}

export function isMonitorSlot(scheduledTime: number, intervalMin: number): boolean {
  return Math.floor(scheduledTime / MINUTE) % intervalMin === 0;
}

export interface MonitorTickResult {
  enabled: boolean;
  ran: boolean;
  notices: { check: CheckName; notice: Notice }[];
}

/** One monitor pass from the cron (send/receive are recorded by the canary itself). */
export async function runMailMonitor(
  env: Env,
  app: AppFetcher,
  scheduledTime: number = Date.now(),
  now: number = Date.now(),
  alerter?: Alerter,
): Promise<MonitorTickResult> {
  const out: MonitorTickResult = { enabled: false, ran: false, notices: [] };
  const cfg = monitorConfig(env);
  if (!cfg) return out;
  out.enabled = true;
  if (!isMonitorSlot(scheduledTime, cfg.intervalMin)) return out;
  out.ran = true;
  const ctx: RequestContext = { requestId: newRequestId(), caller: SERVICE_NAME };
  const db = buildDb(env, ctx.requestId);
  const deps: MonitorDeps = { db, alerter: alerter ?? createAlerter(env, cfg, ctx) };
  const record = async (check: CheckName, run: () => Promise<CheckResult>): Promise<void> => {
    try {
      const notice = await recordCheck(deps, check, await run(), now);
      if (notice) out.notices.push({ check, notice });
    } catch (err) {
      log("error", "mail monitor: check failed to run", ctx, { check, error: errText(err) });
    }
  };
  try {
    const at = new Date(now).toISOString();
    await writeState(db, {
      check_name: "heartbeat",
      status: "ok",
      fail_streak: 0,
      alerting: 0,
      incident_started_at: null,
      pending_notice: null,
      last_run_at: at,
      last_ok_at: at,
      last_detail: `interval ${cfg.intervalMin}min`,
      ref: null,
      updated_at: nowIso(),
    });
  } catch (err) {
    log("error", "mail monitor: heartbeat write failed", ctx, { error: errText(err) });
  }
  await record("send_errors", () => checkSendErrors(db, cfg, now));
  if (cfg.apiUserId) {
    const userId = cfg.apiUserId;
    await record("api", async () => {
      const receive = await readState(db, "receive");
      return checkApi(app, env, userId, receive?.ref ?? null, ctx.requestId);
    });
  }
  return out;
}

// ---------------------------------------------------------------- heartbeat (dead-man's switch)

export interface HeartbeatView {
  enabled: boolean;
  fresh: boolean;
  lastRunAt: string | null;
  staleAfterMin: number;
  checks: { check: StateName; status: string; failStreak: number; alerting: boolean; lastRunAt: string; lastOkAt: string | null; detail: string | null }[];
}

/** Whether the monitor ran recently. app-health-monitor probes this hourly: a cron that
 *  stopped (or a monitor that keeps crashing) surfaces there, outside this Worker. */
export async function heartbeat(env: Env, db: DbClient, now: number = Date.now()): Promise<HeartbeatView> {
  const cfg = monitorConfig(env);
  const staleAfterMin = (cfg?.intervalMin ?? DEFAULT_INTERVAL_MIN) * 3;
  if (!cfg) return { enabled: false, fresh: true, lastRunAt: null, staleAfterMin, checks: [] };
  const rows = await listStates(db);
  const hb = rows.find((r) => r.check_name === "heartbeat");
  const fresh = !!hb && now - Date.parse(hb.last_run_at) <= staleAfterMin * MINUTE;
  return {
    enabled: true,
    fresh,
    lastRunAt: hb?.last_run_at ?? null,
    staleAfterMin,
    checks: rows
      .filter((r) => r.check_name !== "heartbeat")
      .map((r) => ({
        check: r.check_name,
        status: r.status,
        failStreak: r.fail_streak,
        alerting: r.alerting === 1,
        lastRunAt: r.last_run_at,
        lastOkAt: r.last_ok_at,
        detail: r.last_detail,
      })),
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function log(level: "info" | "warn" | "error", message: string, ctx: RequestContext, fields: Record<string, unknown>): void {
  consoleSink({ level, message, service: SERVICE_NAME, requestId: ctx.requestId, fields });
}
