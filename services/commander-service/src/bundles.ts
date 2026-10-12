// staging 合体 (bundle) persistence. A bundle groups demo-approved tasks that wait for a
// staging slot so they share ONE slot via an integration branch (a do-not-merge viewer PR).
// Children keep their own task / runs / PR / approval; the bundle only references them.
//
// The bundle's run reports back through its final result text: one line
//   BUNDLE_RESULT {"status":"deployed","slot":"staging2","stagingUrl":"…","prUrl":"…","markers":{…}}
// which `applyBundleRunEvent` folds onto the bundle when the daemon streams the event in.
// A run that exits without that line leaves the bundle `failed` (never stuck at merging).
import type { D1Database } from "@cloudflare/workers-types";
import { newId, nowIso } from "@dub/db";

export type BundleStatus = "merging" | "deployed" | "failed";
export type BundleSlot = "staging" | "staging2";
export type MarkerState = "pending" | "pass" | "missing";

export interface BundleRow {
  id: string;
  taskIds: string[];
  status: BundleStatus;
  slot: BundleSlot | null;
  stagingUrl: string | null;
  prUrl: string | null;
  branch: string;
  markers: Record<string, MarkerState>;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BundleDb {
  id: string;
  task_ids: string;
  status: BundleStatus;
  slot: BundleSlot | null;
  staging_url: string | null;
  pr_url: string | null;
  branch: string;
  markers: string;
  run_id: string | null;
  created_at: string;
  updated_at: string;
}

const STATUSES: readonly BundleStatus[] = ["merging", "deployed", "failed"];
const SLOTS: readonly BundleSlot[] = ["staging", "staging2"];
const MARKERS: readonly MarkerState[] = ["pending", "pass", "missing"];

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

function toBundle(r: BundleDb): BundleRow {
  return {
    id: r.id,
    taskIds: parseJson<string[]>(r.task_ids, []),
    status: r.status,
    slot: r.slot,
    stagingUrl: r.staging_url,
    prUrl: r.pr_url,
    branch: r.branch,
    markers: parseJson<Record<string, MarkerState>>(r.markers, {}),
    runId: r.run_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listBundles(db: D1Database): Promise<BundleRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM commander_staging_bundles ORDER BY created_at DESC")
    .all<BundleDb>();
  return results.map(toBundle);
}

export async function getBundle(db: D1Database, id: string): Promise<BundleRow | null> {
  const r = await db
    .prepare("SELECT * FROM commander_staging_bundles WHERE id = ?")
    .bind(id)
    .first<BundleDb>();
  return r ? toBundle(r) : null;
}

export type CreateBundleOutcome =
  | { ok: true; bundle: BundleRow }
  | { ok: false; code: "too_few" | "task_not_found" | "already_bundled"; taskIds?: string[] };

/** 2 件以上の既存タスクで、どれも他の束に入っていない時だけ作る。 */
export async function createBundle(db: D1Database, taskIds: string[]): Promise<CreateBundleOutcome> {
  const ids = [...new Set(taskIds)];
  if (ids.length < 2) return { ok: false, code: "too_few" };
  const marks = ids.map(() => "?").join(", ");
  const { results: found } = await db
    .prepare(`SELECT id FROM commander_tasks WHERE id IN (${marks})`)
    .bind(...ids)
    .all<{ id: string }>();
  const missing = ids.filter((id) => !found.some((f) => f.id === id));
  if (missing.length > 0) return { ok: false, code: "task_not_found", taskIds: missing };
  const taken = new Set((await listBundles(db)).flatMap((b) => b.taskIds));
  const dup = ids.filter((id) => taken.has(id));
  if (dup.length > 0) return { ok: false, code: "already_bundled", taskIds: dup };

  const id = newId("bundle");
  const at = nowIso();
  const markers = Object.fromEntries(ids.map((t) => [t, "pending"]));
  await db
    .prepare(
      `INSERT INTO commander_staging_bundles
         (id, task_ids, status, slot, staging_url, pr_url, branch, markers, run_id, created_at, updated_at)
       VALUES (?, ?, 'merging', NULL, NULL, NULL, ?, ?, NULL, ?, ?)`,
    )
    .bind(id, JSON.stringify(ids), `staging/${id}`, JSON.stringify(markers), at, at)
    .run();
  return { ok: true, bundle: (await getBundle(db, id))! };
}

export interface BundlePatch {
  status?: BundleStatus;
  slot?: BundleSlot | null;
  stagingUrl?: string | null;
  prUrl?: string | null;
  markers?: Record<string, MarkerState>;
  runId?: string | null;
}

/** Validate an untrusted patch body (route input or a run's BUNDLE_RESULT). */
export function parseBundlePatch(body: unknown): BundlePatch {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: BundlePatch = {};
  if (STATUSES.includes(b.status as BundleStatus)) out.status = b.status as BundleStatus;
  if (b.slot === null || SLOTS.includes(b.slot as BundleSlot)) out.slot = b.slot as BundleSlot | null;
  for (const k of ["stagingUrl", "prUrl", "runId"] as const) {
    const v = b[k];
    if (v === null || (typeof v === "string" && v.trim() !== "")) out[k] = v === null ? null : v.trim();
  }
  if (b.markers && typeof b.markers === "object" && !Array.isArray(b.markers)) {
    out.markers = Object.fromEntries(
      Object.entries(b.markers as Record<string, unknown>).filter(
        (e): e is [string, MarkerState] => MARKERS.includes(e[1] as MarkerState),
      ),
    );
  }
  return out;
}

export async function updateBundle(
  db: D1Database,
  id: string,
  patch: BundlePatch,
): Promise<BundleRow | null> {
  const cur = await getBundle(db, id);
  if (!cur) return null;
  // Markers only for current children (a child that already left must not reappear).
  const markers = patch.markers
    ? Object.fromEntries(cur.taskIds.map((t) => [t, patch.markers![t] ?? cur.markers[t] ?? "pending"]))
    : cur.markers;
  const next = {
    status: patch.status ?? cur.status,
    slot: patch.slot !== undefined ? patch.slot : cur.slot,
    stagingUrl: patch.stagingUrl !== undefined ? patch.stagingUrl : cur.stagingUrl,
    prUrl: patch.prUrl !== undefined ? patch.prUrl : cur.prUrl,
    runId: patch.runId !== undefined ? patch.runId : cur.runId,
  };
  await db
    .prepare(
      `UPDATE commander_staging_bundles
         SET status = ?, slot = ?, staging_url = ?, pr_url = ?, markers = ?, run_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(next.status, next.slot, next.stagingUrl, next.prUrl, JSON.stringify(markers), next.runId, nowIso(), id)
    .run();
  return getBundle(db, id);
}

/** Take one child out. The last child leaving deletes the bundle (returns `deleted`). */
export async function removeBundleTask(
  db: D1Database,
  id: string,
  taskId: string,
): Promise<{ bundle: BundleRow | null; deleted: boolean } | null> {
  const cur = await getBundle(db, id);
  if (!cur) return null;
  const taskIds = cur.taskIds.filter((t) => t !== taskId);
  if (taskIds.length === 0) {
    await deleteBundle(db, id);
    return { bundle: null, deleted: true };
  }
  const markers = { ...cur.markers };
  delete markers[taskId];
  await db
    .prepare("UPDATE commander_staging_bundles SET task_ids = ?, markers = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(taskIds), JSON.stringify(markers), nowIso(), id)
    .run();
  return { bundle: await getBundle(db, id), deleted: false };
}

export async function deleteBundle(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM commander_staging_bundles WHERE id = ?").bind(id).run();
  return (r.meta?.changes ?? 0) > 0;
}

const REPORT_RE = /BUNDLE_RESULT\s*(\{.*\})/;

/** The BUNDLE_RESULT object in a run's final text, or null when absent / malformed. */
export function parseBundleReport(text: string): BundlePatch | null {
  const m = REPORT_RE.exec(text);
  if (!m) return null;
  try {
    const patch = parseBundlePatch(JSON.parse(m[1]!));
    return patch.status ? patch : null;
  } catch {
    return null;
  }
}

/**
 * Fold a bundle run's events onto its bundle: the final `result` carries BUNDLE_RESULT; an
 * `exit` while the bundle is still `merging` means the run ended without reporting → failed.
 */
export async function applyBundleRunEvent(
  db: D1Database,
  runId: string,
  type: string,
  payload: unknown,
): Promise<void> {
  if (type !== "claude" && type !== "exit") return;
  const row = await db
    .prepare("SELECT id FROM commander_staging_bundles WHERE run_id = ?")
    .bind(runId)
    .first<{ id: string }>();
  if (!row) return;
  if (type === "claude") {
    const data = (payload as { data?: { type?: unknown; result?: unknown } } | null)?.data;
    if (data?.type !== "result" || typeof data.result !== "string") return;
    const report = parseBundleReport(data.result);
    await updateBundle(db, row.id, report ?? { status: "failed" });
    return;
  }
  const cur = await getBundle(db, row.id);
  if (cur?.status === "merging") await updateBundle(db, row.id, { status: "failed" });
}
