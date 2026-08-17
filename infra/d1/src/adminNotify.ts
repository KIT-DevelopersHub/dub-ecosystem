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

import { buildDeployCopy, extractNotifyLine, isPresentableNotifyLine, detectConventionalType, USER_IRRELEVANT_TYPES } from "./deployCopy";

export interface DeployNotifyMeta {
  /** Commit SHA of the deployed tree (required; drives the dedup key + row id). */
  sha: string;
  /** Merged PR title or commit subject (the "what changed"). */
  title?: string;
  /** Human-written notification copy (PR body 1st line). Preferred over `title` for the
   *  reader-facing headline; also opts a user-irrelevant-typed deploy back into notifying. */
  notifyLine?: string;
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
 *  (same meta → same id/dedup), so re-runs are idempotent at the DB layer.
 *
 *  The reader-facing title/body are produced by buildDeployCopy (deployCopy.ts): the raw PR
 *  title / commit subject is classified (新機能 / 改善 / 修正 / 更新) and humanized, so a
 *  developer string like "fix(db): don't mis-parse `DO UPDATE SET` ... (#224)" never lands
 *  verbatim in a notification. The raw title + technical fields (sha/ref/services) are still
 *  persisted in meta_json for admin traceability. */
export function buildDeployNotifyRow(meta: DeployNotifyMeta): NotifNotificationRow {
  if (!meta.sha) throw new Error("buildDeployNotifyRow: sha is required");
  const createdAt = meta.timestamp ?? new Date().toISOString();
  const copy = buildDeployCopy({
    createdAt,
    ...(meta.title ? { title: meta.title } : {}),
    ...(meta.notifyLine ? { notifyLine: meta.notifyLine } : {}),
    ...(meta.url ? { url: meta.url } : {}),
  });
  const metaObj: Record<string, string | number> = { sha: meta.sha, kind: copy.change.kind };
  if (meta.title) metaObj.rawTitle = meta.title; // keep the developer string for traceability
  if (meta.notifyLine) metaObj.notifyLine = meta.notifyLine; // human copy source, for traceability
  if (meta.prNumber) metaObj.prNumber = meta.prNumber;
  if (meta.url) metaObj.url = meta.url;
  if (meta.services) metaObj.services = meta.services;
  if (meta.ref) metaObj.ref = meta.ref;
  return {
    id: `ntfn_deploy_${shortSha(meta.sha)}`,
    type: DEPLOY_NOTIFY_TYPE,
    title: copy.title,
    body: copy.body,
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

/**
 * Whether a deploy should produce an Admin notification at all.
 *
 * A human notify line always wins (opt-in): if the author wrote a presentable PR-body line,
 * we notify. Otherwise a deploy whose commit type is user-irrelevant (docs/chore/ci/deps/…)
 * is skipped, so the inbox is not filled with contentless "アプリを更新しました" rows. Anything
 * with a real change type (feat/fix/perf/refactor/…) or an unknown type still notifies. */
export function shouldNotifyDeploy(meta: DeployNotifyMeta): boolean {
  if (isPresentableNotifyLine(meta.notifyLine)) return true;
  const type = detectConventionalType(meta.title);
  if (type && USER_IRRELEVANT_TYPES.has(type)) return false;
  return true;
}

// ---- backfill (one-time): past merged PRs that never produced an Admin notification ----

/** Shape of a `gh pr list --json number,title,body,url,mergedAt,mergeCommit` item. */
export interface MergedPr {
  number: number;
  title: string;
  /** Full PR body — its 1st line (通知文言) is the preferred notification copy. */
  body?: string;
  url?: string;
  mergedAt?: string;
  mergeCommit?: { oid?: string } | null;
}

/**
 * Map a merged PR to deploy-notify meta, keyed by its merge/squash commit SHA — the SAME
 * key space as the forward CI step (GITHUB_SHA on main), so backfilling a PR and a later
 * CI run for the same commit never double-insert (dedupKey=deploy:<sha>). The PR body's
 * notify line (通知文言) is extracted and preferred over the title for the reader copy.
 *
 * Returns null (→ skipped) when the PR has no merge commit (not actually merged / unknown),
 * OR when the change is user-irrelevant (docs/chore/…) with no human notify line — so the
 * backfill only records notifications a member would actually care about.
 */
export function mergedPrToMeta(pr: MergedPr): DeployNotifyMeta | null {
  const sha = pr.mergeCommit?.oid;
  if (!sha) return null;
  const notifyLine = extractNotifyLine(pr.body);
  const meta: DeployNotifyMeta = {
    sha,
    title: pr.title,
    ...(notifyLine ? { notifyLine } : {}),
    prNumber: pr.number,
    ...(pr.url ? { url: pr.url } : {}),
    ...(pr.mergedAt ? { timestamp: pr.mergedAt } : {}),
    services: "backfill (過去のマージ/デプロイ取り込み)",
  };
  if (!shouldNotifyDeploy(meta)) return null;
  return meta;
}

export interface BackfillRow {
  meta: DeployNotifyMeta;
  row: NotifNotificationRow;
}

/** Build idempotent rows for every merged PR that maps to a commit. `existingDedupKeys`
 *  (already present in D1) are filtered out so the preview/apply count is the true delta. */
export function buildBackfillRows(prs: MergedPr[], existingDedupKeys: ReadonlySet<string> = new Set()): BackfillRow[] {
  const out: BackfillRow[] = [];
  const seen = new Set<string>();
  for (const pr of prs) {
    const meta = mergedPrToMeta(pr);
    if (!meta) continue;
    const key = deployDedupKey(meta.sha);
    if (existingDedupKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ meta, row: buildDeployNotifyRow(meta) });
  }
  return out;
}

/** Concatenate the idempotent INSERTs for a backfill set into one .sql payload. */
export function buildBackfillSql(rows: BackfillRow[]): string {
  return rows.map((r) => buildInsertNotificationSql(r.row)).join("\n");
}
