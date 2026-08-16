// Deploy → Admin notification: build the idempotent SQL that records ONE audience='admin'
// notification row per production deploy. This is the CI-level automation seam.
//
// WHY a direct D1 write (not an HTTP endpoint): notification-service runs with
// workers_dev=false (reachable only via the api-gateway Service Binding), and the gateway
// requires a browser session for /notifications/* and 404s /notifications/internal/*. A CI
// GitHub Action has no session — but it already holds CLOUDFLARE_API_TOKEN + wrangler, so a
// single idempotent INSERT into dub-core D1 is the self-contained, free-tier mechanism.
//
// WHY just one row (no per-admin fan-out here): notification-service materializes every
// audience='admin' row into each admin's inbox lazily on read (repo.backfillAdminAudienceInbox).
// So recording the notification row is sufficient for "Admin には例外なく全部届く"; we never
// need to know admin user ids at write time. Idempotency is the dedup_key unique index:
// re-running the same deploy (dedupKey=deploy:<sha>) is INSERT OR IGNORE → a no-op.

export interface DeployNotifyMeta {
  /** Commit SHA of the deployed tree (required; drives the dedup key + row id). */
  sha: string;
  /** Merged PR title or commit subject (the "what changed"). */
  title?: string;
  /** Merged PR number, if this deploy came from a merge. */
  prNumber?: number;
  /** Merged PR / commit URL. */
  url?: string;
  /** Deployed services/apps summary (free text, e.g. "全Worker + fe2 + mo3"). */
  services?: string;
  /** Git ref deployed (e.g. "refs/heads/main"). */
  ref?: string;
  /** ISO8601 timestamp of the deploy/merge (defaults to now). */
  timestamp?: string;
}

export interface NotifNotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  priority: "normal";
  audience: "admin";
  dedupKey: string;
  source: "api";
  sourceEvent: string;
  actorId: string | null;
  requestId: string;
  resourceType: string;
  resourceId: string;
  metaJson: string;
  createdAt: string;
}

export const DEPLOY_NOTIFY_TYPE = "deploy.completed";
export const DEPLOY_SOURCE_EVENT = "ci.deploy";

/** Stable dedup key for a deploy — one Admin notification per commit SHA. */
export function deployDedupKey(sha: string): string {
  return `deploy:${sha}`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/** Build the canonical audience='admin' notification row for a deploy. Pure + deterministic
 *  (same meta → same id/dedup), so re-runs are idempotent at the DB layer. */
export function buildDeployNotifyRow(meta: DeployNotifyMeta): NotifNotificationRow {
  if (!meta.sha) throw new Error("buildDeployNotifyRow: sha is required");
  const createdAt = meta.timestamp ?? new Date().toISOString();
  const what = (meta.title ?? "").trim() || "本番デプロイ";
  const prSuffix = meta.prNumber ? ` (#${meta.prNumber})` : "";
  const title = `デプロイ完了: ${what}${prSuffix}`;
  const bodyLines = [
    `本番デプロイが完了しました。`,
    ``,
    `変更: ${what}${prSuffix}`,
    `コミット: ${shortSha(meta.sha)}`,
    ...(meta.services ? [`対象: ${meta.services}`] : []),
    ...(meta.ref ? [`ref: ${meta.ref}`] : []),
    `日時: ${createdAt}`,
    ...(meta.url ? [``, meta.url] : []),
  ];
  const metaObj: Record<string, string | number> = { sha: meta.sha };
  if (meta.prNumber) metaObj.prNumber = meta.prNumber;
  if (meta.url) metaObj.url = meta.url;
  if (meta.services) metaObj.services = meta.services;
  if (meta.ref) metaObj.ref = meta.ref;
  return {
    id: `ntfn_deploy_${shortSha(meta.sha)}`,
    type: DEPLOY_NOTIFY_TYPE,
    title,
    body: bodyLines.join("\n"),
    priority: "normal",
    audience: "admin",
    dedupKey: deployDedupKey(meta.sha),
    source: "api",
    sourceEvent: DEPLOY_SOURCE_EVENT,
    actorId: null,
    requestId: `ci-deploy-${shortSha(meta.sha)}`,
    resourceType: "deployment",
    resourceId: meta.sha,
    metaJson: JSON.stringify(metaObj),
    createdAt,
  };
}

/** SQL string literal escape (double single quotes); NULL for null. */
function lit(v: string | null): string {
  if (v === null) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * Idempotent INSERT for one deploy notification. `INSERT OR IGNORE` + the dedup_key unique
 * index mean a re-run (same SHA) inserts nothing. Written to a .sql file and applied with
 * `wrangler d1 execute dub-core --remote --file <f>` (no bound params over --file, so
 * literals are escaped here). notif_notifications only.
 */
export function buildInsertNotificationSql(row: NotifNotificationRow): string {
  const cols = [
    "id",
    "type",
    "title",
    "body",
    "priority",
    "audience",
    "dedup_key",
    "source",
    "source_event",
    "actor_id",
    "request_id",
    "resource_type",
    "resource_id",
    "meta_json",
    "created_at",
  ];
  const vals = [
    lit(row.id),
    lit(row.type),
    lit(row.title),
    lit(row.body),
    lit(row.priority),
    lit(row.audience),
    lit(row.dedupKey),
    lit(row.source),
    lit(row.sourceEvent),
    lit(row.actorId),
    lit(row.requestId),
    lit(row.resourceType),
    lit(row.resourceId),
    lit(row.metaJson),
    lit(row.createdAt),
  ];
  return `INSERT OR IGNORE INTO notif_notifications (${cols.join(", ")})\nVALUES (${vals.join(", ")});`;
}

/** Convenience: meta → idempotent SQL for one deploy notification. */
export function buildDeployNotifySql(meta: DeployNotifyMeta): string {
  return buildInsertNotificationSql(buildDeployNotifyRow(meta));
}
