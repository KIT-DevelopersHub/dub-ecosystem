// Billing-guard alerting (spec E). When a metric crosses warn(80%)/critical(90%) the daily
// alarm fires an admin alert over TWO best-effort channels — never throwing, never blocking:
//   1. In-app EVT_NOTIFICATION via notification-service POST /notify (when admin user ids
//      are configured via USAGE_ALERT_ADMIN_USER_IDS).
//   2. Email via mail-gateway POST /send to the admin address (the reliable channel; no
//      id resolution needed).
// A per-day/per-metric/per-level dedup (backed by DO storage) guarantees at most one alert
// per breach per day even if collection runs multiple times.
// The same channels also carry runCollectionFailureAlert: the meter itself failing on
// consecutive days (otherwise the dashboard silently freezes on old numbers).
import { createServiceClient, newRequestId, type RequestContext } from "@dub/http";
import type { mail, notification } from "@dub/types";
import type { Env } from "./env";
import { utcDayString } from "./time";
import { breachedServices } from "./summary";
import type { UsageServiceSummary, UsageSummary } from "./types";

const SERVICE_NAME = "usage-meter";
const ALERT_TYPE = "usage.threshold_breached";
const FAILURE_ALERT_TYPE = "usage.collection_failed";
const DEFAULT_ALERT_EMAIL = "admin@developershub.jp";
// Default admin fan-out roles (mirrors the feedback -> admin flow: role_sys_admin /
// role_sys_maintainer). The notification service expands these to inboxes, so in-app
// alerts reach admins WITHOUT any USAGE_ALERT_ADMIN_USER_IDS config.
const DEFAULT_ALERT_ROLE_IDS = ["role_sys_admin", "role_sys_maintainer"];

/** Persistence for per-day alert dedup (implemented over Durable Object storage). */
export interface DedupStore {
  seen(key: string): Promise<boolean>;
  mark(key: string): Promise<void>;
}

export interface AlertResult {
  breached: number;
  newlyAlerted: string[]; // metricKeys that crossed a level and were (attempted) alerted today
  emailAttempted: boolean;
  inAppAttempted: boolean;
}

function dedupKey(s: UsageServiceSummary, day: string): string {
  return `alert:${s.metricKey}:${s.status}:${day}`;
}

function fmtPct(s: UsageServiceSummary): string {
  return s.pct === null ? "?" : `${s.pct}%`;
}

/** One-line-per-metric human summary of the breaches. */
export function buildAlertLines(breaches: readonly UsageServiceSummary[]): string[] {
  return breaches.map(
    (s) =>
      `[${s.status.toUpperCase()}] ${s.label}: ${fmtPct(s)} (${s.used ?? "?"}/${s.limit} ${s.unit}` +
      `, 超過時=${s.overflowBehavior === "halt" ? "停止" : "課金"})`,
  );
}

function parseCsv(csv: string | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Roles to fan out the in-app alert to: env override, else the default admin/maintainer. */
function alertRoleIds(env: Env): string[] {
  const configured = parseCsv(env.USAGE_ALERT_ADMIN_ROLE_IDS);
  return configured.length > 0 ? configured : DEFAULT_ALERT_ROLE_IDS;
}

/** One admin alert, rendered for both channels. */
interface AdminAlert {
  type: string;
  /** In-app title; the email subject is `[usage-meter] <title>`. */
  title: string;
  /** Body lines (email gets a trailing dashboard pointer). */
  lines: string[];
  /** Mail idempotency key — the same alert is never mailed twice. */
  idempotencyKey: string;
  /** notification-service dedup key. */
  notifyDedupKey: string;
}

/** Send one alert over email + in-app. Best-effort: a channel failure is logged, never thrown. */
async function deliverAdminAlert(
  env: Env,
  alert: AdminAlert,
  log?: (msg: string, fields?: Record<string, unknown>) => void,
): Promise<{ emailAttempted: boolean; inAppAttempted: boolean }> {
  const ctx: RequestContext = { requestId: newRequestId() };
  const out = { emailAttempted: false, inAppAttempted: false };

  // ---- channel 1: email (reliable) ----
  if (env.SVC_MAIL_GATEWAY) {
    out.emailAttempted = true;
    try {
      const client = createServiceClient(env.SVC_MAIL_GATEWAY, { service: "mail-gateway", caller: SERVICE_NAME });
      const to = env.USAGE_ALERT_EMAIL || DEFAULT_ALERT_EMAIL;
      const email: mail.SendMailRequest = {
        to: [{ email: to, name: "DevHub 管理者" }],
        subject: `[usage-meter] ${alert.title}`,
        textBody: [...alert.lines, "", "ダッシュボード: /usage/summary"].join("\n"),
      };
      await client.post<mail.SendMailResponse, mail.SendMailRequest>(ctx, "/send", email, {
        idempotencyKey: alert.idempotencyKey,
      });
    } catch (err) {
      log?.("usage alert email failed (best-effort)", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---- channel 2: in-app EVT_NOTIFICATION (role fan-out, reliable) ----
  // Roles default to admin/maintainer so this fires WITHOUT any user-id config; an
  // explicit USAGE_ALERT_ADMIN_USER_IDS list (if set) is unioned in.
  if (env.SVC_NOTIFICATION) {
    out.inAppAttempted = true;
    try {
      const client = createServiceClient(env.SVC_NOTIFICATION, { service: "notification", caller: SERVICE_NAME });
      const req: notification.NotifyRequest = {
        type: alert.type,
        recipientIds: parseCsv(env.USAGE_ALERT_ADMIN_USER_IDS),
        title: alert.title,
        body: alert.lines.join("\n"),
        channels: ["in_app"],
        dedupKey: alert.notifyDedupKey,
        resourceType: "usage",
        resourceId: "summary",
      };
      const roleIds = alertRoleIds(env);
      if (roleIds.length > 0) req.recipientRoles = roleIds;
      await client.post<{ notificationId: string; deduplicated: boolean }, notification.NotifyRequest>(ctx, "/notify", req);
    } catch (err) {
      log?.("usage alert in-app notify failed (best-effort)", { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Evaluate the summary and dispatch admin alerts for newly-breached metrics. Best-effort:
 *  every channel failure is swallowed and logged. Returns what happened (for tests/logs). */
export async function runAlerts(
  env: Env,
  summary: UsageSummary,
  now: Date,
  dedup: DedupStore,
  log?: (msg: string, fields?: Record<string, unknown>) => void,
): Promise<AlertResult> {
  const day = utcDayString(now);
  const breaches = breachedServices(summary);

  // filter to breaches not already alerted at this level today
  const fresh: UsageServiceSummary[] = [];
  for (const b of breaches) {
    if (!(await dedup.seen(dedupKey(b, day)))) fresh.push(b);
  }

  const result: AlertResult = {
    breached: breaches.length,
    newlyAlerted: fresh.map((f) => f.metricKey),
    emailAttempted: false,
    inAppAttempted: false,
  };
  if (fresh.length === 0) return result;

  const levels = fresh.map((f) => `${f.metricKey}:${f.status}`).join(",");
  const worst = fresh.some((b) => b.status === "critical") ? "critical" : "warn";
  Object.assign(
    result,
    await deliverAdminAlert(
      env,
      {
        type: ALERT_TYPE,
        title: `無料枠しきい値超過 (${fresh.length}件・最大 ${worst})`,
        lines: ["無料枠の使用率がしきい値を超えました。", "", ...buildAlertLines(fresh)],
        idempotencyKey: `usage-alert:${day}:${levels}`,
        notifyDedupKey: `usage:${levels}`,
      },
      log,
    ),
  );

  // mark dedup for every fresh breach (regardless of channel outcome) -> <=1 alert/day/level
  for (const b of fresh) await dedup.mark(dedupKey(b, day));

  return result;
}

/** Alert once a collection failure has repeated this many times in a row. One miss can be a
 *  blip; two consecutive daily misses means the meter has stopped measuring. */
export const FAILURE_ALERT_AFTER = 2;

export interface CollectionHealth {
  /** Consecutive failed collections, including the current one. */
  consecutiveFailures: number;
  /** Why the latest collection failed. */
  lastError: string;
  /** ISO time of the last successful collection, or null if unknown. */
  lastSuccessAt: string | null;
}

/** Tell admins the meter itself is failing (the dashboard would otherwise freeze on old
 *  numbers silently). Fires once FAILURE_ALERT_AFTER consecutive failures are reached, at
 *  most once per UTC day. Best-effort; returns whether an alert was dispatched. */
export async function runCollectionFailureAlert(
  env: Env,
  health: CollectionHealth,
  now: Date,
  dedup: DedupStore,
  log?: (msg: string, fields?: Record<string, unknown>) => void,
): Promise<boolean> {
  if (health.consecutiveFailures < FAILURE_ALERT_AFTER) return false;
  const day = utcDayString(now);
  const key = `alert:collection_failed:${day}`;
  if (await dedup.seen(key)) return false;

  await deliverAdminAlert(
    env,
    {
      type: FAILURE_ALERT_TYPE,
      title: `使用量の収集が ${health.consecutiveFailures} 回連続で失敗しています`,
      lines: [
        "無料枠の使用量を収集できていません。ダッシュボードの数値は古いままです。",
        "",
        `連続失敗: ${health.consecutiveFailures} 回`,
        `最後に成功: ${health.lastSuccessAt ?? "不明"}`,
        `直近の失敗理由: ${health.lastError}`,
      ],
      idempotencyKey: `usage-collection-failed:${day}`,
      notifyDedupKey: `usage:collection_failed:${day}`,
    },
    log,
  );
  await dedup.mark(key);
  return true;
}
