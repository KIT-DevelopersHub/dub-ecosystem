// Billing-guard alerting (spec E). When a metric crosses warn(70%)/critical(90%) the daily
// alarm fires an admin alert over TWO best-effort channels — never throwing, never blocking:
//   1. In-app EVT_NOTIFICATION via notification-service POST /notify (when admin user ids
//      are configured via USAGE_ALERT_ADMIN_USER_IDS).
//   2. Email via mail-gateway POST /send to the admin address (the reliable channel; no
//      id resolution needed).
// A per-day/per-metric/per-level dedup (backed by DO storage) guarantees at most one alert
// per breach per day even if collection runs multiple times.
import { createServiceClient, newRequestId, type RequestContext } from "@dub/http";
import type { mail, notification } from "@dub/types";
import type { Env } from "./env";
import { utcDayString } from "./time";
import { breachedServices } from "./summary";
import type { UsageServiceSummary, UsageSummary } from "./types";

const SERVICE_NAME = "usage-meter";
const ALERT_TYPE = "usage.threshold_breached";
const DEFAULT_ALERT_EMAIL = "admin@developershub.jp";

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

function parseAdminIds(csv: string | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildEmail(to: string, breaches: readonly UsageServiceSummary[]): mail.SendMailRequest {
  const lines = [
    "無料枠の使用率がしきい値を超えました。",
    "",
    ...buildAlertLines(breaches),
    "",
    "ダッシュボード: /usage/summary",
  ];
  return {
    to: [{ email: to, name: "DevHub 管理者" }],
    subject: `[usage-meter] 無料枠しきい値超過 (${breaches.length}件)`,
    textBody: lines.join("\n"),
  };
}

function buildNotify(recipientIds: string[], breaches: readonly UsageServiceSummary[]): notification.NotifyRequest {
  const worst = breaches.some((b) => b.status === "critical") ? "critical" : "warn";
  return {
    type: ALERT_TYPE,
    recipientIds,
    title: `無料枠しきい値超過 (${breaches.length}件・最大 ${worst})`,
    body: buildAlertLines(breaches).join("\n"),
    channels: ["in_app"],
    dedupKey: `usage:${breaches.map((b) => `${b.metricKey}:${b.status}`).join(",")}`,
    resourceType: "usage",
    resourceId: "summary",
  };
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

  const ctx: RequestContext = { requestId: newRequestId() };

  // ---- channel 1: email (reliable) ----
  if (env.SVC_MAIL_GATEWAY) {
    result.emailAttempted = true;
    try {
      const client = createServiceClient(env.SVC_MAIL_GATEWAY, { service: "mail-gateway", caller: SERVICE_NAME });
      const to = env.USAGE_ALERT_EMAIL || DEFAULT_ALERT_EMAIL;
      await client.post<mail.SendMailResponse, mail.SendMailRequest>(ctx, "/send", buildEmail(to, fresh), {
        idempotencyKey: `usage-alert:${day}:${fresh.map((f) => `${f.metricKey}:${f.status}`).join(",")}`,
      });
    } catch (err) {
      log?.("usage alert email failed (best-effort)", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---- channel 2: in-app EVT_NOTIFICATION ----
  const adminIds = parseAdminIds(env.USAGE_ALERT_ADMIN_USER_IDS);
  if (env.SVC_NOTIFICATION && adminIds.length > 0) {
    result.inAppAttempted = true;
    try {
      const client = createServiceClient(env.SVC_NOTIFICATION, { service: "notification", caller: SERVICE_NAME });
      await client.post<{ notificationId: string; deduplicated: boolean }, notification.NotifyRequest>(
        ctx,
        "/notify",
        buildNotify(adminIds, fresh),
      );
    } catch (err) {
      log?.("usage alert in-app notify failed (best-effort)", { error: err instanceof Error ? err.message : String(err) });
    }
  } else if (env.SVC_NOTIFICATION) {
    log?.("usage alert in-app skipped: no USAGE_ALERT_ADMIN_USER_IDS configured");
  }

  // mark dedup for every fresh breach (regardless of channel outcome) -> <=1 alert/day/level
  for (const b of fresh) await dedup.mark(dedupKey(b, day));

  return result;
}
