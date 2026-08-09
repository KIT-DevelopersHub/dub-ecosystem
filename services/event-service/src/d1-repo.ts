// D1-backed EventRepo. Owns namespace `event_*` only (enforced by @dub/db strict
// client). All timestamps come from the service (nowIso), never DDL DEFAULT (D2).
import type { DbClient } from "@dub/db";
import type { common, event } from "@dub/types";
import type { EventRepo, EventRow, ActionRow, Keyset } from "./types";

interface EventDbRow {
  id: string;
  org_id: string;
  title: string;
  description: string | null;
  phase: string;
  starts_at: string | null;
  ends_at: string | null;
  archived_at: string | null;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface ActionDbRow {
  id: string;
  event_id: string;
  kind: string;
  title: string;
  sort_order: number;
  archived_at: string | null;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function toEventRow(r: EventDbRow): EventRow {
  return {
    id: r.id,
    orgId: r.org_id,
    title: r.title,
    description: r.description,
    phase: r.phase as event.EventPhase,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    archivedAt: r.archived_at,
    version: r.version,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function toActionRow(r: ActionDbRow): ActionRow {
  return {
    id: r.id,
    eventId: r.event_id,
    kind: r.kind,
    title: r.title,
    sortOrder: r.sort_order,
    archivedAt: r.archived_at,
    version: r.version,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createD1EventRepo(db: DbClient): EventRepo {
  return {
    async createEvent(row: EventRow): Promise<void> {
      await db.run(
        `INSERT INTO event_events
          (id, org_id, title, description, phase, starts_at, ends_at, version, archived_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.orgId, row.title, row.description, row.phase, row.startsAt, row.endsAt,
        row.version, row.archivedAt, row.createdBy, row.createdAt, row.updatedAt,
      );
    },

    async getEvent(id: common.EventId): Promise<EventRow | null> {
      const r = await db.first<EventDbRow>(`SELECT * FROM event_events WHERE id = ?`, id);
      return r ? toEventRow(r) : null;
    },

    async listEvents(q): Promise<EventRow[]> {
      const where: string[] = ["org_id = ?"];
      const binds: unknown[] = [q.orgId];
      if (!q.includeArchived) where.push("archived_at IS NULL");
      if (q.phase) {
        where.push("phase = ?");
        binds.push(q.phase);
      }
      if (q.startsAfter) {
        where.push("starts_at IS NOT NULL AND starts_at >= ?");
        binds.push(q.startsAfter);
      }
      let order: string;
      if (q.sort === "startsAt") {
        if (q.after) {
          // keyset over (starts_at NULLS LAST, id)
          const s = q.after.s ?? null;
          if (s === null) {
            where.push("(starts_at IS NULL AND id > ?)");
            binds.push(q.after.id);
          } else {
            where.push("(starts_at > ? OR (starts_at = ? AND id > ?) OR starts_at IS NULL)");
            binds.push(s, s, q.after.id);
          }
        }
        order = "ORDER BY starts_at IS NULL, starts_at ASC, id ASC";
      } else {
        if (q.after) {
          where.push("id > ?");
          binds.push(q.after.id);
        }
        order = "ORDER BY id ASC";
      }
      binds.push(q.limit);
      const rows = await db.all<EventDbRow>(
        `SELECT * FROM event_events WHERE ${where.join(" AND ")} ${order} LIMIT ?`,
        ...binds,
      );
      return rows.map(toEventRow);
    },

    async updateEvent(next: EventRow, expectedVersion: number): Promise<boolean> {
      const res = await db.run(
        `UPDATE event_events SET
           title = ?, description = ?, phase = ?, starts_at = ?, ends_at = ?,
           archived_at = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
        next.title, next.description, next.phase, next.startsAt, next.endsAt,
        next.archivedAt, next.version, next.updatedAt, next.id, expectedVersion,
      );
      return res.meta.changes > 0;
    },

    async createAction(row: ActionRow): Promise<void> {
      await db.run(
        `INSERT INTO event_actions
          (id, event_id, kind, title, sort_order, archived_at, version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.eventId, row.kind, row.title, row.sortOrder, row.archivedAt,
        row.version, row.createdBy, row.createdAt, row.updatedAt,
      );
    },

    async getAction(id: common.ActionId): Promise<ActionRow | null> {
      const r = await db.first<ActionDbRow>(`SELECT * FROM event_actions WHERE id = ?`, id);
      return r ? toActionRow(r) : null;
    },

    async listActions(q): Promise<ActionRow[]> {
      const where: string[] = ["event_id = ?"];
      const binds: unknown[] = [q.eventId];
      if (!q.includeArchived) where.push("archived_at IS NULL");
      if (q.kind) {
        where.push("kind = ?");
        binds.push(q.kind);
      }
      if (q.after) {
        // keyset over (sort_order, id) to match the ORDER BY
        where.push("(sort_order > ? OR (sort_order = ? AND id > ?))");
        const n = q.after.n ?? 0;
        binds.push(n, n, q.after.id);
      }
      binds.push(q.limit);
      const rows = await db.all<ActionDbRow>(
        `SELECT * FROM event_actions WHERE ${where.join(" AND ")} ORDER BY sort_order ASC, id ASC LIMIT ?`,
        ...binds,
      );
      return rows.map(toActionRow);
    },

    async updateAction(next: ActionRow, expectedVersion: number): Promise<boolean> {
      const res = await db.run(
        `UPDATE event_actions SET
           kind = ?, title = ?, sort_order = ?, archived_at = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
        next.kind, next.title, next.sortOrder, next.archivedAt, next.version, next.updatedAt,
        next.id, expectedVersion,
      );
      return res.meta.changes > 0;
    },

    async actionsForEvent(eventId: common.EventId, cap: number): Promise<ActionRow[]> {
      const rows = await db.all<ActionDbRow>(
        `SELECT * FROM event_actions WHERE event_id = ? AND archived_at IS NULL ORDER BY sort_order ASC, id ASC LIMIT ?`,
        eventId, cap,
      );
      return rows.map(toActionRow);
    },

    async maxSortOrder(eventId: common.EventId): Promise<number> {
      const r = await db.first<{ m: number | null }>(
        `SELECT MAX(sort_order) AS m FROM event_actions WHERE event_id = ?`,
        eventId,
      );
      return r?.m ?? 0;
    },
  } satisfies EventRepo;
}
