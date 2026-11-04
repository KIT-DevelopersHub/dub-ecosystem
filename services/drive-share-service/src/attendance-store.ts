// Persistence for 定例の出席 (driveshare/0004): which meetings are 定例, and one row per member per
// occurrence (JST date) they attended or were excused from. D1 in production, in-memory for unit
// tests (same observable semantics, mirroring meetings-store.ts). Timestamps are service-set.
import type { DbClient } from "@dub/db";
import type { meeting } from "@dub/types";

export interface AttendanceRow {
  meetingId: string;
  /** JST date of the occurrence. */
  occurrenceDate: string;
  userId: string;
  orgId: string;
  status: meeting.AttendanceStatus;
  source: meeting.AttendanceSource;
  joinedAt: string | null;
  recordedBy: string;
  updatedAt: string;
}

export interface AttendanceStore {
  /** Ids of the org's 定例 meetings. */
  listRegularIds(orgId: string): Promise<Set<string>>;
  setRegular(orgId: string, meetingId: string, enabled: boolean, by: string, at: string): Promise<void>;
  get(meetingId: string, occurrenceDate: string, userId: string): Promise<AttendanceRow | null>;
  upsert(row: AttendanceRow): Promise<void>;
  remove(meetingId: string, occurrenceDate: string, userId: string): Promise<void>;
  /** Every record of the org with occurrenceDate in [from, to]. */
  listRange(orgId: string, from: string, to: string): Promise<AttendanceRow[]>;
}

interface AttendanceDbRow {
  meeting_id: string;
  occurrence_date: string;
  user_id: string;
  org_id: string;
  status: string;
  source: string;
  joined_at: string | null;
  recorded_by: string;
  updated_at: string;
}

const toRow = (r: AttendanceDbRow): AttendanceRow => ({
  meetingId: r.meeting_id,
  occurrenceDate: r.occurrence_date,
  userId: r.user_id,
  orgId: r.org_id,
  status: r.status as meeting.AttendanceStatus,
  source: r.source as meeting.AttendanceSource,
  joinedAt: r.joined_at,
  recordedBy: r.recorded_by,
  updatedAt: r.updated_at,
});

export function createD1AttendanceStore(db: DbClient): AttendanceStore {
  return {
    async listRegularIds(orgId) {
      const rows = await db.all<{ meeting_id: string }>(`SELECT meeting_id FROM driveshare_meeting_regulars WHERE org_id = ?`, orgId);
      return new Set(rows.map((r) => r.meeting_id));
    },
    async setRegular(orgId, meetingId, enabled, by, at) {
      if (enabled) {
        await db.run(
          `INSERT OR IGNORE INTO driveshare_meeting_regulars (meeting_id, org_id, enabled_by, enabled_at) VALUES (?, ?, ?, ?)`,
          meetingId, orgId, by, at,
        );
      } else {
        await db.run(`DELETE FROM driveshare_meeting_regulars WHERE org_id = ? AND meeting_id = ?`, orgId, meetingId);
      }
    },
    async get(meetingId, occurrenceDate, userId) {
      const r = await db.first<AttendanceDbRow>(
        `SELECT * FROM driveshare_meeting_attendance WHERE meeting_id = ? AND occurrence_date = ? AND user_id = ?`,
        meetingId, occurrenceDate, userId,
      );
      return r ? toRow(r) : null;
    },
    async upsert(a) {
      await db.run(
        `INSERT OR REPLACE INTO driveshare_meeting_attendance
           (meeting_id, occurrence_date, user_id, org_id, status, source, joined_at, recorded_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.meetingId, a.occurrenceDate, a.userId, a.orgId, a.status, a.source, a.joinedAt, a.recordedBy, a.updatedAt,
      );
    },
    async remove(meetingId, occurrenceDate, userId) {
      await db.run(
        `DELETE FROM driveshare_meeting_attendance WHERE meeting_id = ? AND occurrence_date = ? AND user_id = ?`,
        meetingId, occurrenceDate, userId,
      );
    },
    async listRange(orgId, from, to) {
      const rows = await db.all<AttendanceDbRow>(
        `SELECT * FROM driveshare_meeting_attendance WHERE org_id = ? AND occurrence_date >= ? AND occurrence_date <= ?
          ORDER BY occurrence_date ASC, meeting_id ASC, user_id ASC`,
        orgId, from, to,
      );
      return rows.map(toRow);
    },
  };
}

const keyOf = (meetingId: string, date: string, userId: string) => `${meetingId}|${date}|${userId}`;

export function createInMemoryAttendanceStore(): AttendanceStore & { rows: Map<string, AttendanceRow>; regulars: Map<string, string> } {
  const rows = new Map<string, AttendanceRow>();
  /** meetingId -> orgId */
  const regulars = new Map<string, string>();
  return {
    rows,
    regulars,
    async listRegularIds(orgId) {
      return new Set([...regulars].filter(([, o]) => o === orgId).map(([id]) => id));
    },
    async setRegular(orgId, meetingId, enabled) {
      if (enabled) regulars.set(meetingId, orgId);
      else regulars.delete(meetingId);
    },
    async get(meetingId, date, userId) {
      const r = rows.get(keyOf(meetingId, date, userId));
      return r ? { ...r } : null;
    },
    async upsert(a) {
      rows.set(keyOf(a.meetingId, a.occurrenceDate, a.userId), { ...a });
    },
    async remove(meetingId, date, userId) {
      rows.delete(keyOf(meetingId, date, userId));
    },
    async listRange(orgId, from, to) {
      return [...rows.values()]
        .filter((r) => r.orgId === orgId && r.occurrenceDate >= from && r.occurrenceDate <= to)
        .map((r) => ({ ...r }));
    },
  };
}
