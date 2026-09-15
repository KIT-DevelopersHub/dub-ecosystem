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
  return { id, featureId, title: input.title, status, createdAt: at, updatedAt: at };
}

export async function listTasks(db: D1Database, featureId: string): Promise<TaskRow[]> {
  const res = await db
    .prepare("SELECT * FROM commander_tasks WHERE feature_id = ? ORDER BY created_at ASC")
    .bind(featureId)
    .all<TaskDb>();
  return (res.results ?? []).map(toTask);
}
