// Durable record of the latest per-target state (flapping source of truth) + an append-only
// incident log (down / recovery transitions) for admin visibility. Stored in un-namespaced
// tables on the shared dub-core D1 (same convention as freeq_outbox), created via db/0001_monitor.sql.
import type { D1Database } from "@cloudflare/workers-types";
import type { Health, TargetKind, TargetState } from "./types";

export interface StatusRow extends TargetState {
  kind: TargetKind;
  label: string;
}

export interface IncidentRow {
  id: string;
  targetId: string;
  label: string;
  kind: "down" | "recovery";
  detail: string;
  at: string;
}

/** Persistence seam. The DO uses the D1 impl; tests use an in-memory impl. */
export interface MonitorRepo {
  loadStates(): Promise<Map<string, TargetState>>;
  saveStatus(row: StatusRow): Promise<void>;
  addIncident(row: IncidentRow): Promise<void>;
  listStatuses(): Promise<StatusRow[]>;
}

export function createD1Repo(db: D1Database): MonitorRepo {
  return {
    async loadStates(): Promise<Map<string, TargetState>> {
      const { results } = await db
        .prepare(
          `SELECT target_id, status, consecutive_fails, down_since, notified, last_error, last_checked_at
             FROM monitor_status`,
        )
        .all<{
          target_id: string;
          status: string;
          consecutive_fails: number;
          down_since: string | null;
          notified: number;
          last_error: string | null;
          last_checked_at: string;
        }>();
      const map = new Map<string, TargetState>();
      for (const r of results ?? []) {
        map.set(r.target_id, {
          targetId: r.target_id,
          status: (r.status === "ok" ? "ok" : "down") as Health,
          consecutiveFails: r.consecutive_fails,
          downSince: r.down_since,
          notified: r.notified === 1,
          lastError: r.last_error,
          lastCheckedAt: r.last_checked_at,
        });
      }
      return map;
    },

    async saveStatus(row: StatusRow): Promise<void> {
      await db
        .prepare(
          `INSERT INTO monitor_status
             (target_id, kind, label, status, consecutive_fails, down_since, notified, last_error, last_checked_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
           ON CONFLICT(target_id) DO UPDATE SET
             kind = excluded.kind,
             label = excluded.label,
             status = excluded.status,
             consecutive_fails = excluded.consecutive_fails,
             down_since = excluded.down_since,
             notified = excluded.notified,
             last_error = excluded.last_error,
             last_checked_at = excluded.last_checked_at,
             updated_at = excluded.updated_at`,
        )
        .bind(
          row.targetId,
          row.kind,
          row.label,
          row.status,
          row.consecutiveFails,
          row.downSince,
          row.notified ? 1 : 0,
          row.lastError,
          row.lastCheckedAt,
        )
        .run();
    },

    async addIncident(row: IncidentRow): Promise<void> {
      await db
        .prepare(`INSERT INTO monitor_incident (id, target_id, label, kind, detail, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
        .bind(row.id, row.targetId, row.label, row.kind, row.detail, row.at)
        .run();
    },

    async listStatuses(): Promise<StatusRow[]> {
      const { results } = await db
        .prepare(
          `SELECT target_id, kind, label, status, consecutive_fails, down_since, notified, last_error, last_checked_at
             FROM monitor_status ORDER BY status DESC, target_id ASC`,
        )
        .all<{
          target_id: string;
          kind: string;
          label: string;
          status: string;
          consecutive_fails: number;
          down_since: string | null;
          notified: number;
          last_error: string | null;
          last_checked_at: string;
        }>();
      return (results ?? []).map((r) => ({
        targetId: r.target_id,
        kind: (r.kind === "frontend" ? "frontend" : "service") as TargetKind,
        label: r.label,
        status: (r.status === "ok" ? "ok" : "down") as Health,
        consecutiveFails: r.consecutive_fails,
        downSince: r.down_since,
        notified: r.notified === 1,
        lastError: r.last_error,
        lastCheckedAt: r.last_checked_at,
      }));
    },
  };
}

/** In-memory repo for tests / the no-DB degrade path. */
export function createMemoryRepo(seed?: StatusRow[]): MonitorRepo {
  const statuses = new Map<string, StatusRow>();
  const incidents: IncidentRow[] = [];
  for (const s of seed ?? []) statuses.set(s.targetId, s);
  return {
    async loadStates() {
      const m = new Map<string, TargetState>();
      for (const [k, v] of statuses) m.set(k, { ...v });
      return m;
    },
    async saveStatus(row) {
      statuses.set(row.targetId, { ...row });
    },
    async addIncident(row) {
      incidents.push({ ...row });
    },
    async listStatuses() {
      return [...statuses.values()];
    },
  };
}
