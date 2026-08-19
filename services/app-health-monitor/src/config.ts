// app-health-monitor constants + the target registry. Centralized so the poll cadence,
// flapping thresholds, and the list of what "opens" gets checked live in one place.
import type { Env } from "./env";

export const SERVICE_NAME = "app-health-monitor";

// Poll cadence. Hourly, per the requirement ("1時間に1回くらい"). Driven by the MonitorDO
// alarm — NOT a Cron Trigger — because the Workers Free plan's 5-cron ACCOUNT cap is already
// full of business crons and a DO alarm does not count against it (same pattern as
// usage-meter / freeq-drain). Same $0, no manual Paid upgrade.
export const POLL_INTERVAL_MS = 60 * 60 * 1000;

// Flapping suppression: a target must FAIL this many consecutive polls before we alert admins
// (so a single transient blip never pages). Recovery clears immediately on the next OK poll.
export const FAIL_THRESHOLD = 2;

// Per-probe network timeout. Kept short so one hung target can't stall the whole cycle.
export const PROBE_TIMEOUT_MS = 10_000;

// Admin fan-out roles (mirrors feedback / usage-meter admin alerting). The notification
// service expands these to admin/maintainer inboxes, so alerts reach admins WITHOUT any
// user-id config, and — being addressed to admin roles only — never reach ordinary members.
export const ADMIN_ROLE_IDS = ["role_sys_admin", "role_sys_maintainer"] as const;

// Notification type for health alerts (open vocabulary; FE can badge on it later).
export const HEALTH_NOTIFY_TYPE = "ops.health";

// Default public origins (workers.dev). Overridable via FE_ORIGIN / GATEWAY_ORIGIN vars so a
// custom domain (api.developershub.jp) can be pointed at without a code change.
export const DEFAULT_FE_ORIGIN = "https://dub-fe2-app-shell.developershub-site.workers.dev";
export const DEFAULT_GATEWAY_ORIGIN = "https://dub-api-gateway.developershub-site.workers.dev";

export function feOrigin(env: Env): string {
  return (env.FE_ORIGIN || DEFAULT_FE_ORIGIN).replace(/\/$/, "");
}
export function gatewayOrigin(env: Env): string {
  return (env.GATEWAY_ORIGIN || DEFAULT_GATEWAY_ORIGIN).replace(/\/$/, "");
}

// ---- Frontend app rows (粒度=アプリ単位). Each is a client-side route in the single fe2 SPA;
// mirrors the app launcher / HomeScreen tiles. "opens" = the SPA fallback serves the route
// (200 + real HTML) AND every built JS/CSS chunk the SPA needs is present (the stale-chunk
// guard — this is exactly the "something went wrong" incident that motivated the monitor). The
// chunk existence check is shared across all app rows (one asset sweep per cycle). ----
export interface FrontendApp {
  id: string; // stable target id suffix (fe:<id>)
  label: string; // human name shown in the admin alert
  route: string; // SPA path to GET (fallback returns index.html)
}
export const FRONTEND_APPS: FrontendApp[] = [
  { id: "home", label: "ホーム", route: "/" },
  { id: "events", label: "イベント", route: "/events" },
  { id: "tasks", label: "マイタスク", route: "/me/tasks" },
  { id: "gantt", label: "ガントチャート", route: "/gantt" },
  { id: "notifications", label: "通知", route: "/notifications" },
  { id: "chat", label: "チャット", route: "/chat" },
  { id: "mail", label: "メール", route: "/mail" },
  { id: "usage", label: "無料枠", route: "/usage" },
  { id: "members", label: "運営メンバー", route: "/members" },
  { id: "driveshare", label: "Drive共有", route: "/driveshare" },
  { id: "roles", label: "ロール管理", route: "/admin/roles" },
];

// Build-emitted manifest of every JS/CSS asset the SPA ships (apps/fe2-app-shell/scripts/
// gen-app-health.mjs writes it to dist/app-health.json at build time). Served as a static
// asset. A 404 on ANY listed asset means a deploy landed index.html but not all its chunks —
// the exact failure that surfaces to users as a blank "something went wrong".
export const APP_HEALTH_MANIFEST_PATH = "/app-health.json";

// ---- Backend service rows. Probed over their Service Binding /health (or /internal/health);
// the internal marker is attached so /internal/* routes accept the probe. api-gateway is
// probed over PUBLIC HTTP (/healthz) instead — it is the one externally-reachable service and
// the same liveness the deploy smoke uses. ----
export interface ServiceTarget {
  id: string;
  label: string;
  binding: keyof Env; // SVC_* fetcher on Env
  path: string;
}
export const SERVICE_TARGETS: ServiceTarget[] = [
  { id: "identity-roster", label: "認証基盤 (identity-roster)", binding: "SVC_IDENTITY", path: "/health" },
  { id: "auth-service", label: "認証 (auth-service)", binding: "SVC_AUTH", path: "/health" },
  { id: "event-service", label: "イベント (event-service)", binding: "SVC_EVENT", path: "/health" },
  { id: "task-service", label: "タスク (task-service)", binding: "SVC_TASK", path: "/health" },
  { id: "gantt-service", label: "ガント (gantt-service)", binding: "SVC_GANTT", path: "/health" },
  { id: "notification", label: "通知 (notification)", binding: "SVC_NOTIFICATION", path: "/internal/health" },
  { id: "mail-gateway", label: "メール (mail-gateway)", binding: "SVC_MAIL_GATEWAY", path: "/internal/health" },
  { id: "chat-service", label: "チャット (chat-service)", binding: "SVC_CHAT", path: "/health" },
  { id: "member-service", label: "メンバー (member-service)", binding: "SVC_MEMBER", path: "/health" },
  { id: "usage-meter", label: "無料枠 (usage-meter)", binding: "SVC_USAGE", path: "/internal/health" },
  { id: "file-meta", label: "添付メタ (file-meta)", binding: "SVC_FILE_META", path: "/internal/health" },
  { id: "audit-log", label: "監査 (audit-log)", binding: "SVC_AUDIT", path: "/internal/health" },
  { id: "deploy-service", label: "デプロイ (deploy-service)", binding: "SVC_DEPLOY", path: "/health" },
  { id: "drive-share-service", label: "Drive共有 (drive-share-service)", binding: "SVC_DRIVE_SHARE", path: "/internal/health" },
  { id: "drive-proxy", label: "Driveプロキシ (drive-proxy)", binding: "SVC_DRIVE_PROXY", path: "/internal/health" },
  { id: "github-sync", label: "GitHub同期 (github-sync)", binding: "SVC_GITHUB_SYNC", path: "/internal/health" },
  { id: "webhook-ingest", label: "Webhook (webhook-ingest)", binding: "SVC_WEBHOOK", path: "/internal/health" },
];

// The gateway is probed over public HTTP (not a binding). id kept stable for the status table.
export const GATEWAY_TARGET = { id: "api-gateway", label: "APIゲートウェイ (api-gateway)", path: "/healthz" };
