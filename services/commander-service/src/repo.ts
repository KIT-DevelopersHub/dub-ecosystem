// D1 persistence for the Commander phase state machine (commander_ namespace on
// dub-core). Raw D1 prepare()/bind() — no ORM. The phase-gate rules live in
// @dub/commander-phases and are applied in `transitionFeature` BEFORE any write, so an
// illegal (段飛ばし) or unapproved (自己承認) move never reaches the DB.
import type { D1Database } from "@cloudflare/workers-types";
import { newId, nowIso } from "@dub/db";
import {
  INITIAL_PHASE,
  findTransition,
  transition,
  isFeaturePhase,
  PhaseTransitionError,
  type FeaturePhase,
} from "@dub/commander-phases";
import { extractArtifactUrls, eventText, mergeUrls } from "./urls";

export interface FeatureRow {
  id: string;
  title: string;
  phase: FeaturePhase;
  ledgerRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TransitionRow {
  id: string;
  featureId: string;
  fromPhase: FeaturePhase;
  toPhase: FeaturePhase;
  approvedByUser: boolean;
  actor: "user" | "system";
  note: string | null;
  createdAt: string;
}

export interface TaskRow {
  id: string;
  featureId: string;
  title: string;
  status: "todo" | "doing" | "done";
  /** Artifact URLs auto-extracted from the task's run output (P1-2; nullable). */
  demoUrl: string | null;
  stagingUrl: string | null;
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FeatureDb {
  id: string;
  title: string;
  phase: string;
  ledger_ref: string | null;
  created_at: string;
  updated_at: string;
}
interface TransitionDb {
  id: string;
  feature_id: string;
  from_phase: string;
  to_phase: string;
  approved_by_user: number;
  actor: string;
  note: string | null;
  created_at: string;
}
interface TaskDb {
  id: string;
  feature_id: string;
  title: string;
  status: string;
  demo_url: string | null;
  staging_url: string | null;
  pr_url: string | null;
  created_at: string;
  updated_at: string;
}

function toFeature(r: FeatureDb): FeatureRow {
  return {
    id: r.id,
    title: r.title,
    phase: r.phase as FeaturePhase,
    ledgerRef: r.ledger_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function toTransition(r: TransitionDb): TransitionRow {
  return {
    id: r.id,
    featureId: r.feature_id,
    fromPhase: r.from_phase as FeaturePhase,
    toPhase: r.to_phase as FeaturePhase,
    approvedByUser: r.approved_by_user === 1,
    actor: r.actor as "user" | "system",
    note: r.note,
    createdAt: r.created_at,
  };
}
function toTask(r: TaskDb): TaskRow {
  return {
    id: r.id,
    featureId: r.feature_id,
    title: r.title,
    status: r.status as TaskRow["status"],
    demoUrl: r.demo_url ?? null,
    stagingUrl: r.staging_url ?? null,
    prUrl: r.pr_url ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// --- Features -------------------------------------------------------------

export async function createFeature(
  db: D1Database,
  input: { title: string; ledgerRef?: string | null },
): Promise<FeatureRow> {
  const id = newId("feat");
  const at = nowIso();
  await db
    .prepare(
      "INSERT INTO commander_features (id, title, phase, ledger_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id, input.title, INITIAL_PHASE, input.ledgerRef ?? null, at, at)
    .run();
  return {
    id,
    title: input.title,
    phase: INITIAL_PHASE,
    ledgerRef: input.ledgerRef ?? null,
    createdAt: at,
    updatedAt: at,
  };
}

export async function listFeatures(db: D1Database): Promise<FeatureRow[]> {
  const res = await db
    .prepare("SELECT * FROM commander_features ORDER BY created_at DESC")
    .all<FeatureDb>();
  return (res.results ?? []).map(toFeature);
}

export async function getFeature(db: D1Database, id: string): Promise<FeatureRow | null> {
  const row = await db
    .prepare("SELECT * FROM commander_features WHERE id = ?")
    .bind(id)
    .first<FeatureDb>();
  return row ? toFeature(row) : null;
}

export async function listTransitions(
  db: D1Database,
  featureId: string,
): Promise<TransitionRow[]> {
  const res = await db
    .prepare(
      "SELECT * FROM commander_phase_transitions WHERE feature_id = ? ORDER BY created_at ASC",
    )
    .bind(featureId)
    .all<TransitionDb>();
  return (res.results ?? []).map(toTransition);
}

export type TransitionOutcome =
  | { ok: true; feature: FeatureRow; transition: TransitionRow }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "invalid_phase" }
  | { ok: false; code: PhaseTransitionError["code"]; message: string; httpStatus: 409 | 403 };

/**
 * Apply a phase transition through the FSM gate, then persist the new phase and an
 * immutable audit row. Returns a discriminated outcome so the HTTP layer maps codes
 * to statuses (illegal=409, approval_required=403, not_found=404, invalid_phase=400).
 */
export async function transitionFeature(
  db: D1Database,
  featureId: string,
  to: string,
  opts: { approvedByUser?: boolean; note?: string | null } = {},
): Promise<TransitionOutcome> {
  const feature = await getFeature(db, featureId);
  if (!feature) return { ok: false, code: "not_found" };
  if (!isFeaturePhase(to)) return { ok: false, code: "invalid_phase" };

  const from = feature.phase;
  const approvedByUser = opts.approvedByUser === true;

  try {
    transition(from, to, { approvedByUser });
  } catch (e) {
    if (e instanceof PhaseTransitionError) {
      return { ok: false, code: e.code, message: e.message, httpStatus: e.httpStatus };
    }
    throw e;
  }

  // requiresApproval edge advanced by the user => actor "user"; otherwise "system".
  const spec = findTransition(from, to)!;
  const actor: "user" | "system" = spec.requiresApproval ? "user" : "system";
  const at = nowIso();
  const txId = newId("ptx");

  // Atomic: advance the phase AND append the audit row together, so the phase can
  // never move without its immutable PhaseTransition record (D1 batch = one tx).
  await db.batch([
    db
      .prepare("UPDATE commander_features SET phase = ?, updated_at = ? WHERE id = ?")
      .bind(to, at, featureId),
    db
      .prepare(
        "INSERT INTO commander_phase_transitions (id, feature_id, from_phase, to_phase, approved_by_user, actor, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(txId, featureId, from, to, approvedByUser ? 1 : 0, actor, opts.note ?? null, at),
  ]);

  return {
    ok: true,
    feature: { ...feature, phase: to, updatedAt: at },
    transition: {
      id: txId,
      featureId,
      fromPhase: from,
      toPhase: to,
      approvedByUser,
      actor,
      note: opts.note ?? null,
      createdAt: at,
    },
  };
}

// --- Tasks (minimal) ------------------------------------------------------

export async function createTask(
  db: D1Database,
  featureId: string,
  input: { title: string; status?: TaskRow["status"] },
): Promise<TaskRow | null> {
  const feature = await getFeature(db, featureId);
  if (!feature) return null;
  const id = newId("ctask");
  const at = nowIso();
  const status = input.status ?? "todo";
  await db
    .prepare(
      "INSERT INTO commander_tasks (id, feature_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id, featureId, input.title, status, at, at)
    .run();
  return {
    id,
    featureId,
    title: input.title,
    status,
    demoUrl: null,
    stagingUrl: null,
    prUrl: null,
    createdAt: at,
    updatedAt: at,
  };
}

export async function listTasks(db: D1Database, featureId: string): Promise<TaskRow[]> {
  const res = await db
    .prepare("SELECT * FROM commander_tasks WHERE feature_id = ? ORDER BY created_at ASC")
    .bind(featureId)
    .all<TaskDb>();
  return (res.results ?? []).map(toTask);
}

/** Advance a task's lifecycle status (todo/doing/done). `done` = archived (Done lane). */
export async function updateTaskStatus(
  db: D1Database,
  taskId: string,
  status: TaskRow["status"],
): Promise<TaskRow | null> {
  const at = nowIso();
  const res = await db
    .prepare("UPDATE commander_tasks SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, at, taskId)
    .run();
  if ((res.meta?.changes ?? 0) === 0) return null;
  const row = await db
    .prepare("SELECT * FROM commander_tasks WHERE id = ?")
    .bind(taskId)
    .first<TaskDb>();
  return row ? toTask(row) : null;
}

// --- Task board aggregate (cross-feature) ---------------------------------
// The Commander board's single read: every task joined to its feature (phase/title)
// and its latest run (status/cwd). 1 task = 1 feature = 1 worktree, so this is the
// operator's whole workboard in one query — lanes are derived from these fields web-side.

export interface BoardItem {
  taskId: string;
  featureId: string;
  title: string;
  featurePhase: FeaturePhase;
  taskStatus: TaskRow["status"];
  /** Artifact URLs (P1-2) surfaced on the card / 成果物 tab; null until extracted. */
  demoUrl: string | null;
  stagingUrl: string | null;
  prUrl: string | null;
  latestRun: { id: string; status: RunStatus; cwd: string; createdAt: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface BoardItemDb {
  id: string;
  feature_id: string;
  title: string;
  status: string;
  demo_url: string | null;
  staging_url: string | null;
  pr_url: string | null;
  created_at: string;
  updated_at: string;
  feature_phase: string;
  run_id: string | null;
  run_status: string | null;
  run_cwd: string | null;
  run_created_at: string | null;
}

export async function listBoard(db: D1Database): Promise<BoardItem[]> {
  const res = await db
    .prepare(
      `SELECT t.id, t.feature_id, t.title, t.status,
              t.demo_url, t.staging_url, t.pr_url, t.created_at, t.updated_at,
              f.phase AS feature_phase,
              r.id AS run_id, r.status AS run_status, r.cwd AS run_cwd, r.created_at AS run_created_at
         FROM commander_tasks t
         JOIN commander_features f ON f.id = t.feature_id
         LEFT JOIN commander_runs r ON r.id = (
           SELECT id FROM commander_runs
            WHERE task_id = t.id
            ORDER BY created_at DESC, id DESC
            LIMIT 1
         )
        ORDER BY t.created_at DESC`,
    )
    .all<BoardItemDb>();
  return (res.results ?? []).map((r) => ({
    taskId: r.id,
    featureId: r.feature_id,
    title: r.title,
    featurePhase: r.feature_phase as FeaturePhase,
    taskStatus: r.status as TaskRow["status"],
    demoUrl: r.demo_url ?? null,
    stagingUrl: r.staging_url ?? null,
    prUrl: r.pr_url ?? null,
    latestRun: r.run_id
      ? {
          id: r.run_id,
          status: (r.run_status ?? "pending") as RunStatus,
          cwd: r.run_cwd ?? "",
          createdAt: r.run_created_at ?? "",
        }
      : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// --- Artifact URL extraction persistence (P1-2) ---------------------------
// URLs are parsed from run output (see ./urls.ts) and stored on the task so the board
// can offer a click-through link. Latest-wins: a later match (e.g. a re-deploy) replaces
// the stored URL. Only fields present in `urls` are written (a partial match never clears
// a previously-found URL).

/** Set the given artifact URL columns on a task (only the provided fields). No-op if
 *  nothing to write or the task is unknown. */
export async function updateTaskUrls(
  db: D1Database,
  taskId: string,
  urls: { demoUrl?: string; stagingUrl?: string; prUrl?: string },
): Promise<void> {
  const sets: string[] = [];
  const vals: string[] = [];
  if (urls.demoUrl) {
    sets.push("demo_url = ?");
    vals.push(urls.demoUrl);
  }
  if (urls.stagingUrl) {
    sets.push("staging_url = ?");
    vals.push(urls.stagingUrl);
  }
  if (urls.prUrl) {
    sets.push("pr_url = ?");
    vals.push(urls.prUrl);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  vals.push(nowIso());
  await db
    .prepare(`UPDATE commander_tasks SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals, taskId)
    .run();
}

/**
 * Backfill artifact URLs for every task from its existing run events — for runs that
 * completed before P1-2 (their URLs were never captured live). Scans each task's run
 * output in chronological order (latest-wins) and writes what it finds. Returns how many
 * tasks were updated.
 */
export async function backfillTaskUrls(db: D1Database): Promise<{ updated: number }> {
  const res = await db
    .prepare(
      `SELECT r.task_id AS task_id, e.type AS type, e.payload AS payload
         FROM commander_run_events e
         JOIN commander_runs r ON r.id = e.run_id
        WHERE r.task_id IS NOT NULL
        ORDER BY e.created_at ASC, e.id ASC`,
    )
    .all<{ task_id: string; type: string; payload: string }>();

  const perTask = new Map<string, { demoUrl?: string; stagingUrl?: string; prUrl?: string }>();
  for (const row of res.results ?? []) {
    let payload: unknown = {};
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = row.payload;
    }
    const found = extractArtifactUrls(eventText(payload));
    if (!found.demoUrl && !found.stagingUrl && !found.prUrl) continue;
    perTask.set(row.task_id, mergeUrls(perTask.get(row.task_id) ?? {}, found));
  }

  let updated = 0;
  for (const [taskId, urls] of perTask) {
    await updateTaskUrls(db, taskId, urls);
    updated += 1;
  }
  return { updated };
}

/**
 * Create a feature (INITIAL_PHASE) and its single task together (1 task = 1 feature).
 * This is the Commander board's "new task" primitive: the composer creates the work
 * unit here, then starts a run against it (runs.task_id). Atomic (D1 batch).
 */
export async function createFeatureTask(
  db: D1Database,
  input: { title: string; ledgerRef?: string | null },
): Promise<{ feature: FeatureRow; task: TaskRow }> {
  const featureId = newId("feat");
  const taskId = newId("ctask");
  const at = nowIso();
  await db.batch([
    db
      .prepare(
        "INSERT INTO commander_features (id, title, phase, ledger_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(featureId, input.title, INITIAL_PHASE, input.ledgerRef ?? null, at, at),
    db
      .prepare(
        "INSERT INTO commander_tasks (id, feature_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(taskId, featureId, input.title, "todo", at, at),
  ]);
  return {
    feature: {
      id: featureId,
      title: input.title,
      phase: INITIAL_PHASE,
      ledgerRef: input.ledgerRef ?? null,
      createdAt: at,
      updatedAt: at,
    },
    task: {
      id: taskId,
      featureId,
      title: input.title,
      status: "todo",
      demoUrl: null,
      stagingUrl: null,
      prUrl: null,
      createdAt: at,
      updatedAt: at,
    },
  };
}

// --- Runs + run events (persistence for the local daemon's executions) ----
// The loopback daemon cannot reach D1 (ADR 0004), so it POSTs each run + event here
// and this worker persists them. commander_run_events is append-only; a status/exit
// event also folds into the commander_runs row (status / exit_code) so a run's current
// state is a single-row read.

export type RunStatus = "pending" | "running" | "succeeded" | "failed";
const RUN_STATUSES: readonly RunStatus[] = ["pending", "running", "succeeded", "failed"];
function isRunStatus(v: unknown): v is RunStatus {
  return typeof v === "string" && (RUN_STATUSES as readonly string[]).includes(v);
}

export type RunEventType = "status" | "claude" | "stdout" | "stderr" | "exit" | "error";
const RUN_EVENT_TYPES: readonly RunEventType[] = [
  "status",
  "claude",
  "stdout",
  "stderr",
  "exit",
  "error",
];
export function isRunEventType(v: unknown): v is RunEventType {
  return typeof v === "string" && (RUN_EVENT_TYPES as readonly string[]).includes(v);
}

export interface RunRow {
  id: string;
  taskId: string | null;
  prompt: string;
  cwd: string;
  status: RunStatus;
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
}
export interface RunEventRow {
  id: string;
  runId: string;
  type: RunEventType;
  payload: unknown;
  createdAt: string;
}

interface RunDb {
  id: string;
  task_id: string | null;
  prompt: string;
  cwd: string;
  status: string;
  exit_code: number | null;
  created_at: string;
  updated_at: string;
}
interface RunEventDb {
  id: string;
  run_id: string;
  type: string;
  payload: string;
  created_at: string;
}

function toRun(r: RunDb): RunRow {
  return {
    id: r.id,
    taskId: r.task_id,
    prompt: r.prompt,
    cwd: r.cwd,
    status: r.status as RunStatus,
    exitCode: r.exit_code,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function toRunEvent(r: RunEventDb): RunEventRow {
  let payload: unknown = {};
  try {
    payload = JSON.parse(r.payload);
  } catch {
    payload = {};
  }
  return { id: r.id, runId: r.run_id, type: r.type as RunEventType, payload, createdAt: r.created_at };
}

export async function createRun(
  db: D1Database,
  input: { id?: string; prompt: string; cwd: string; status?: RunStatus; taskId?: string | null; at?: string },
): Promise<RunRow> {
  const id = input.id ?? newId("run");
  const at = input.at ?? nowIso();
  const status: RunStatus = input.status && isRunStatus(input.status) ? input.status : "pending";
  await db
    .prepare(
      "INSERT INTO commander_runs (id, task_id, prompt, cwd, status, exit_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, input.taskId ?? null, input.prompt, input.cwd, status, null, at, at)
    .run();
  return { id, taskId: input.taskId ?? null, prompt: input.prompt, cwd: input.cwd, status, exitCode: null, createdAt: at, updatedAt: at };
}

export async function getRun(db: D1Database, id: string): Promise<RunRow | null> {
  const row = await db.prepare("SELECT * FROM commander_runs WHERE id = ?").bind(id).first<RunDb>();
  return row ? toRun(row) : null;
}

export async function listRuns(db: D1Database): Promise<RunRow[]> {
  const res = await db
    .prepare("SELECT * FROM commander_runs ORDER BY created_at DESC")
    .all<RunDb>();
  return (res.results ?? []).map(toRun);
}

export async function listRunEvents(db: D1Database, runId: string): Promise<RunEventRow[]> {
  const res = await db
    .prepare("SELECT * FROM commander_run_events WHERE run_id = ? ORDER BY created_at ASC, id ASC")
    .bind(runId)
    .all<RunEventDb>();
  return (res.results ?? []).map(toRunEvent);
}

/**
 * Append one run event (append-only audit) and, when it is a status/exit event, fold the
 * new state into the commander_runs row — atomically (D1 batch). Returns null if the run
 * does not exist. `payload` is stored as JSON; the daemon's non-column event fields live there.
 */
export async function appendRunEvent(
  db: D1Database,
  runId: string,
  input: { type: RunEventType; payload?: unknown; at?: string },
): Promise<RunEventRow | null> {
  const run = await getRun(db, runId);
  if (!run) return null;
  const id = newId("rev");
  const at = input.at ?? nowIso();
  const payload = input.payload ?? {};
  const payloadJson = JSON.stringify(payload);

  const stmts = [
    db
      .prepare(
        "INSERT INTO commander_run_events (id, run_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(id, runId, input.type, payloadJson, at),
  ];

  // Fold status/exit into the run row so a run's current state is one row read.
  const p = payload as { status?: unknown; code?: unknown };
  if (input.type === "status" && isRunStatus(p.status)) {
    stmts.push(
      db
        .prepare("UPDATE commander_runs SET status = ?, updated_at = ? WHERE id = ?")
        .bind(p.status, at, runId),
    );
  } else if (input.type === "exit" && (typeof p.code === "number" || p.code === null)) {
    stmts.push(
      db
        .prepare("UPDATE commander_runs SET exit_code = ?, updated_at = ? WHERE id = ?")
        .bind(typeof p.code === "number" ? p.code : null, at, runId),
    );
  }

  // P1-2: harvest artifact URLs from this event and fold them onto the owning task,
  // in the same batch so the run event and its extracted URLs commit atomically.
  if (run.taskId) {
    const found = extractArtifactUrls(eventText(payload));
    const urlSets: string[] = [];
    const urlVals: string[] = [];
    if (found.demoUrl) {
      urlSets.push("demo_url = ?");
      urlVals.push(found.demoUrl);
    }
    if (found.stagingUrl) {
      urlSets.push("staging_url = ?");
      urlVals.push(found.stagingUrl);
    }
    if (found.prUrl) {
      urlSets.push("pr_url = ?");
      urlVals.push(found.prUrl);
    }
    if (urlSets.length > 0) {
      urlSets.push("updated_at = ?");
      urlVals.push(at);
      stmts.push(
        db
          .prepare(`UPDATE commander_tasks SET ${urlSets.join(", ")} WHERE id = ?`)
          .bind(...urlVals, run.taskId),
      );
    }
  }

  await db.batch(stmts);
  return { id, runId, type: input.type, payload, createdAt: at };
}
