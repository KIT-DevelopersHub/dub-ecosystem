// Demo seed scenarios (#29 contract). Idempotent by fixed prefix-ULID ids
// (INSERT OR REPLACE; audit_logs uses INSERT OR IGNORE to respect its append-only
// trigger). `isolate: true` suffixes generated ids with a runId so a shared preview D1
// can seed concurrently and each run's cleanup() removes only its own rows.
//
// Prod guard is by database_name (theme-12): passing databaseName === "dub-core"
// throws SEED_ENV_FORBIDDEN — env self-report is never trusted.
import type { D1Database } from "@cloudflare/workers-types";
import { DubError } from "@dub/errors";
import { ulid, nowIso } from "@dub/db";
import { PROD_DB_NAME } from "../src/errors";
import { SEED, SEED_TS, SEED_AUDIT_TS, fixtureHash, type TestUserKey } from "./fixtures";

export type SeedScenarioName = "minimal" | "conference-demo" | "rbac-matrix";
export type { TestUserKey };

export interface SeedScenarioOptions {
  /** true = suffix generated ids with runId for concurrent preview seeding. */
  isolate?: boolean;
  /** database_name of the target D1; "dub-core" (prod) is rejected. */
  databaseName?: string;
}

export interface SeedHandle {
  runId: string; // "fixed" when isolate is false, else a ULID
  scenario: SeedScenarioName;
  inserted: number;
  cleanup(): Promise<void>;
}

interface DeleteSpec {
  table: string;
  where: Record<string, unknown>;
}

class Writer {
  inserted = 0;
  private readonly deletes: DeleteSpec[] = [];
  constructor(private readonly db: D1Database) {}

  async upsert(table: string, row: Record<string, unknown>, mode: "replace" | "ignore", key: string[]): Promise<void> {
    const cols = Object.keys(row);
    const sql = `INSERT OR ${mode === "replace" ? "REPLACE" : "IGNORE"} INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    await this.db
      .prepare(sql)
      .bind(...cols.map((c) => row[c] ?? null))
      .run();
    this.inserted += 1;
    const where: Record<string, unknown> = {};
    for (const k of key) where[k] = row[k];
    this.deletes.push({ table, where });
  }

  async cleanup(): Promise<void> {
    // reverse insertion order = FK-safe (children before parents).
    for (const d of [...this.deletes].reverse()) {
      const keys = Object.keys(d.where);
      const sql = `DELETE FROM ${d.table} WHERE ${keys.map((k) => `${k} = ?`).join(" AND ")}`;
      await this.db
        .prepare(sql)
        .bind(...keys.map((k) => d.where[k] ?? null))
        .run();
    }
  }
}

export async function seedScenario(db: D1Database, name: SeedScenarioName, opts: SeedScenarioOptions = {}): Promise<SeedHandle> {
  if (opts.databaseName === PROD_DB_NAME) {
    throw new DubError("SEED_ENV_FORBIDDEN", `refusing to seed the prod database "${PROD_DB_NAME}"`, { status: 403 });
  }

  const isolate = name !== "minimal" && opts.isolate === true; // minimal is fixed-only (design §2-4)
  const runId = isolate ? ulid() : "fixed";
  const sfx = isolate ? `_${runId}` : "";
  const w = new Writer(db);

  const userKeys: TestUserKey[] = name === "minimal" ? ["admin", "member"] : ["admin", "organizer", "member"];
  const withOutsider = name === "rbac-matrix";
  const taskCount = name === "minimal" ? 2 : 10;

  const adminId = SEED.users.admin.id + sfx;

  // 1. outsider org + role (rbac-matrix only). Primary org + system roles come from the
  //    identity migration, so we never re-create them here.
  if (withOutsider) {
    const outOrgId = SEED.orgs.outsider.id + sfx;
    await w.upsert("identity_orgs", { id: outOrgId, name: SEED.orgs.outsider.name, created_at: SEED_TS }, "replace", ["id"]);
    await w.upsert(
      "identity_roles",
      { id: SEED.outsiderRoleId + sfx, org_id: outOrgId, name: "member", is_system: 1, created_at: SEED_TS, updated_at: SEED_TS },
      "replace",
      ["id"],
    );
  }

  // 2. demo users + role assignments.
  for (const key of userKeys) {
    const u = SEED.users[key];
    const uid = u.id + sfx;
    const local = u.email.split("@")[0];
    const domain = u.email.split("@")[1];
    const email = isolate ? `${local}+${runId}@${domain}` : u.email;
    await w.upsert(
      "identity_users",
      { id: uid, org_id: SEED.orgs.primary.id, email, display_name: u.displayName, github_login: null, avatar_url: null, status: "active", created_at: SEED_TS, updated_at: SEED_TS },
      "replace",
      ["id"],
    );
    const roleId = SEED.roleIds[u.role];
    await w.upsert(
      "identity_role_assignments",
      { id: `ra_${key}${sfx}`, user_id: uid, role_id: roleId, org_id: SEED.orgs.primary.id, resource_type: null, resource_id: null, granted_by: adminId, granted_at: SEED_TS },
      "replace",
      ["id"],
    );
  }
  if (withOutsider) {
    const ou = SEED.users.outsider;
    const ouid = ou.id + sfx;
    const outOrgId = SEED.orgs.outsider.id + sfx;
    const local = ou.email.split("@")[0];
    const domain = ou.email.split("@")[1];
    const email = isolate ? `${local}+${runId}@${domain}` : ou.email;
    await w.upsert(
      "identity_users",
      { id: ouid, org_id: outOrgId, email, display_name: ou.displayName, github_login: null, avatar_url: null, status: "active", created_at: SEED_TS, updated_at: SEED_TS },
      "replace",
      ["id"],
    );
    await w.upsert(
      "identity_role_assignments",
      { id: `ra_outsider${sfx}`, user_id: ouid, role_id: SEED.outsiderRoleId + sfx, org_id: outOrgId, resource_type: null, resource_id: null, granted_by: ouid, granted_at: SEED_TS },
      "replace",
      ["id"],
    );
  }

  // 3. event + actions.
  const eventId = SEED.event.id + sfx;
  await w.upsert(
    "event_events",
    { id: eventId, org_id: SEED.orgs.primary.id, title: SEED.event.name, description: "Seeded demo conference", phase: "planning", starts_at: "2026-08-05T00:00:00.000Z", ends_at: "2026-08-06T00:00:00.000Z", version: 1, archived_at: null, created_by: adminId, created_at: SEED_TS, updated_at: SEED_TS },
    "replace",
    ["id"],
  );
  const actionSpecs: Array<[string, string]> =
    name === "minimal" ? [["venue", SEED.actions.venue]] : [["venue", SEED.actions.venue], ["sponsor", SEED.actions.sponsor]];
  for (let i = 0; i < actionSpecs.length; i++) {
    const [kind, baseId] = actionSpecs[i]!;
    await w.upsert(
      "event_actions",
      { id: baseId + sfx, event_id: eventId, kind, title: `${kind} action`, sort_order: i, version: 1, archived_at: null, created_by: adminId, created_at: SEED_TS, updated_at: SEED_TS },
      "replace",
      ["id"],
    );
  }

  // 4. tasks (+ 2 dependencies). status/priority/assignee spread across users.
  const statuses = ["todo", "in_progress", "blocked", "done", "todo", "in_progress", "todo", "done", "todo", "blocked"];
  const priorities = ["high", "medium", "urgent", "low", "medium", "high", "low", "medium", "high", "urgent"];
  const assignees = userKeys.map((k) => SEED.users[k].id + sfx);
  const taskIds: string[] = [];
  for (let i = 0; i < taskCount; i++) {
    const id = i === 0 ? SEED.tasks.root + sfx : i === 1 ? SEED.tasks.blocked + sfx : `task_seed_${String(i).padStart(2, "0")}${sfx}`;
    taskIds.push(id);
    await w.upsert(
      "task_tasks",
      { id, event_id: eventId, title: `Demo task ${i + 1}`, description: null, status: statuses[i % statuses.length], priority: priorities[i % priorities.length], assignee_id: assignees[i % assignees.length], due_at: null, origin: "internal", version: 1, due_soon_notified_at: null, created_by: adminId, created_at: SEED_TS, updated_at: SEED_TS, archived_at: null },
      "replace",
      ["id"],
    );
  }
  // blocked -> root, and (if present) task_03 -> root
  const depPairs: Array<[string, string]> = [[taskIds[1]!, taskIds[0]!]];
  if (taskIds.length > 2) depPairs.push([taskIds[2]!, taskIds[0]!]);
  for (const [taskId, dependsOn] of depPairs) {
    await w.upsert("task_dependencies", { task_id: taskId, depends_on_id: dependsOn, created_at: SEED_TS }, "replace", ["task_id", "depends_on_id"]);
  }

  // 5. notifications / inbox / preferences (conference-demo + rbac only).
  if (name !== "minimal") {
    const notifSpecs = [
      { id: `notif_seed_01${sfx}`, user: "admin", read: true },
      { id: `notif_seed_02${sfx}`, user: "organizer", read: false },
      { id: `notif_seed_03${sfx}`, user: "member", read: false },
    ];
    for (let i = 0; i < notifSpecs.length; i++) {
      const s = notifSpecs[i]!;
      await w.upsert(
        "notif_notifications",
        { id: s.id, type: "task.assigned", title: `Task assigned #${i + 1}`, body: "You have a new task", priority: "normal", dedup_key: null, source: "queue", source_event: "task.assigned", actor_id: adminId, request_id: `req_seed_${i}`, resource_type: "task", resource_id: taskIds[i % taskIds.length]!, meta_json: "{}", created_at: SEED_TS },
        "replace",
        ["id"],
      );
      const uid = SEED.users[s.user as TestUserKey].id + sfx;
      await w.upsert(
        "notif_inbox",
        { id: `inbox_seed_${i}${sfx}`, notification_id: s.id, user_id: uid, read_at: s.read ? SEED_TS : null, created_at: SEED_TS },
        "replace",
        ["id"],
      );
    }
    for (const key of userKeys) {
      const uid = SEED.users[key].id + sfx;
      await w.upsert(
        "notif_preferences",
        { user_id: uid, type: "*", channel: "in_app", enabled: 1, updated_at: SEED_TS },
        "replace",
        ["user_id", "type", "channel"],
      );
    }

    // 6. files + links.
    for (let i = 0; i < 3; i++) {
      const fid = `file_seed_${i}${sfx}`;
      await w.upsert(
        "file_meta_files",
        { id: fid, name: `demo-${i}.pdf`, mime_type: "application/pdf", size_bytes: 1024 * (i + 1), owner_id: adminId, visibility: "org", drive_file_id: null, r2_key: `seed/demo-${i}${sfx}.pdf`, archived_at: null, created_by: adminId, created_at: SEED_TS, updated_at: SEED_TS },
        "replace",
        ["id"],
      );
      const target = i === 0 ? { type: "event", id: eventId } : { type: "task", id: taskIds[i % taskIds.length]! };
      await w.upsert(
        "file_meta_links",
        { file_id: fid, target_type: target.type, target_id: target.id, linked_by: adminId, linked_at: SEED_TS, archived_at: null },
        "replace",
        ["file_id", "target_type", "target_id"],
      );
    }

    // 7. audit sample logs (INSERT OR IGNORE; backdated so cleanup may delete them).
    const auditSpecs = [
      { action: "identity.role.assigned", result: "success", rt: "user", rid: SEED.users.member.id + sfx },
      { action: "event.event.created", result: "success", rt: "event", rid: eventId },
      { action: "deploy.deployment.created", result: "success", rt: "deployment", rid: "dep_seed_1" },
      { action: "deploy.deployment.created", result: "failure", rt: "deployment", rid: "dep_seed_2" },
      { action: "identity.role.revoked", result: "denied", rt: "user", rid: SEED.users.organizer.id + sfx },
    ];
    for (let i = 0; i < auditSpecs.length; i++) {
      const a = auditSpecs[i]!;
      await w.upsert(
        "audit_logs",
        { id: `audit_seed_${i}${sfx}`, action: a.action, actor_id: adminId, org_id: SEED.orgs.primary.id, result: a.result, resource_type: a.rt, resource_id: a.rid, request_id: `req_seed_audit_${i}`, occurred_at: SEED_AUDIT_TS, recorded_at: nowIso(), details_json: "{}" },
        "ignore",
        ["id"],
      );
    }
  }

  // seed_runs ledger (idempotent: UNIQUE(dataset, run_id, fixture_hash)).
  await w.upsert(
    "seed_runs",
    { id: `seedrun_${runId}`, dataset: name, run_id: runId, fixture_hash: fixtureHash(), applied_at: nowIso() },
    "ignore",
    ["id"],
  );

  return {
    runId,
    scenario: name,
    inserted: w.inserted,
    cleanup: () => w.cleanup(),
  };
}
