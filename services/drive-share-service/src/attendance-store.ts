// Persistence for 定例の出席 (driveshare/0004): 定例 flags, manual / Dub-join records, ingested Meet
// participants, the ingest ledger, Google account id -> member links and the threshold setting.
// D1 in production, in-memory for unit tests (same observable semantics). Timestamps are service-set.
import type { DbClient } from "@dub/db";
import type { meeting } from "@dub/types";

/** A stored record: 人事's manual one, or a Dub join. (Meet attendance is derived, never stored.) */
export interface AttendanceRow {
  meetingId: string;
  /** JST date of the occurrence. */
  occurrenceDate: string;
  userId: string;
  orgId: string;
  status: meeting.AttendanceStatus;
  source: "join" | "manual";
  joinedAt: string | null;
  recordedBy: string;
  updatedAt: string;
}

export interface ParticipantRow {
  meetingId: string;
  occurrenceDate: string;
  participantKey: string;
  orgId: string;
  kind: meeting.MeetParticipantKind;
  googleUserId: string | null;
  displayName: string;
  firstJoin: string;
  lastLeave: string | null;
  durationSeconds: number;
  approx: boolean;
  ingestedAt: string;
}

export interface IngestRow {
  meetingId: string;
  occurrenceDate: string;
  orgId: string;
  status: meeting.MeetIngestStatus;
  conferences: number;
  participants: number;
  attempts: number;
  lastError: string | null;
  ingestedAt: string;
}

export interface LinkRow {
  orgId: string;
  googleUserId: string;
  userId: string;
  source: "self" | "confirmed";
  linkedBy: string;
  linkedAt: string;
}

export interface AttendanceStore {
  listRegularIds(orgId: string): Promise<Set<string>>;
  setRegular(orgId: string, meetingId: string, enabled: boolean, by: string, at: string): Promise<void>;

  getRecord(meetingId: string, date: string, userId: string, source: AttendanceRow["source"]): Promise<AttendanceRow | null>;
  upsertRecord(row: AttendanceRow): Promise<void>;
  removeRecord(meetingId: string, date: string, userId: string, source: AttendanceRow["source"]): Promise<void>;
  /** Every record of the org with occurrenceDate in [from, to]. */
  listRecords(orgId: string, from: string, to: string): Promise<AttendanceRow[]>;

  /** Replace one occurrence's participants (idempotent re-ingest). */
  replaceParticipants(orgId: string, meetingId: string, date: string, rows: readonly ParticipantRow[]): Promise<void>;
  listParticipants(orgId: string, from: string, to: string): Promise<ParticipantRow[]>;

  getIngest(meetingId: string, date: string): Promise<IngestRow | null>;
  putIngest(row: IngestRow): Promise<void>;
  listIngests(orgId: string, from: string, to: string): Promise<IngestRow[]>;
  lastIngestAt(orgId: string): Promise<string | null>;

  listLinks(orgId: string): Promise<LinkRow[]>;
  putLink(row: LinkRow): Promise<void>;
  removeLink(orgId: string, googleUserId: string): Promise<void>;

  getMinPercent(orgId: string): Promise<number | null>;
  setMinPercent(orgId: string, minPercent: number, by: string, at: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

interface RecordDb {
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
const toRecord = (r: RecordDb): AttendanceRow => ({
  meetingId: r.meeting_id,
  occurrenceDate: r.occurrence_date,
  userId: r.user_id,
  orgId: r.org_id,
  status: r.status as meeting.AttendanceStatus,
  source: r.source as AttendanceRow["source"],
  joinedAt: r.joined_at,
  recordedBy: r.recorded_by,
  updatedAt: r.updated_at,
});

interface ParticipantDb {
  meeting_id: string;
  occurrence_date: string;
  participant_key: string;
  org_id: string;
  kind: string;
  google_user_id: string | null;
  display_name: string;
  first_join: string;
  last_leave: string | null;
  duration_seconds: number;
  approx: number;
  ingested_at: string;
}
const toParticipant = (r: ParticipantDb): ParticipantRow => ({
  meetingId: r.meeting_id,
  occurrenceDate: r.occurrence_date,
  participantKey: r.participant_key,
  orgId: r.org_id,
  kind: r.kind as meeting.MeetParticipantKind,
  googleUserId: r.google_user_id,
  displayName: r.display_name,
  firstJoin: r.first_join,
  lastLeave: r.last_leave,
  durationSeconds: Number(r.duration_seconds),
  approx: Number(r.approx) === 1,
  ingestedAt: r.ingested_at,
});

interface IngestDb {
  meeting_id: string;
  occurrence_date: string;
  org_id: string;
  status: string;
  conferences: number;
  participants: number;
  attempts: number;
  last_error: string | null;
  ingested_at: string;
}
const toIngest = (r: IngestDb): IngestRow => ({
  meetingId: r.meeting_id,
  occurrenceDate: r.occurrence_date,
  orgId: r.org_id,
  status: r.status as meeting.MeetIngestStatus,
  conferences: Number(r.conferences),
  participants: Number(r.participants),
  attempts: Number(r.attempts),
  lastError: r.last_error,
  ingestedAt: r.ingested_at,
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

    async getRecord(meetingId, date, userId, source) {
      const r = await db.first<RecordDb>(
        `SELECT * FROM driveshare_meeting_attendance WHERE meeting_id = ? AND occurrence_date = ? AND user_id = ? AND source = ?`,
        meetingId, date, userId, source,
      );
      return r ? toRecord(r) : null;
    },
    async upsertRecord(a) {
      await db.run(
        `INSERT OR REPLACE INTO driveshare_meeting_attendance
           (meeting_id, occurrence_date, user_id, org_id, status, source, joined_at, recorded_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.meetingId, a.occurrenceDate, a.userId, a.orgId, a.status, a.source, a.joinedAt, a.recordedBy, a.updatedAt,
      );
    },
    async removeRecord(meetingId, date, userId, source) {
      await db.run(
        `DELETE FROM driveshare_meeting_attendance WHERE meeting_id = ? AND occurrence_date = ? AND user_id = ? AND source = ?`,
        meetingId, date, userId, source,
      );
    },
    async listRecords(orgId, from, to) {
      const rows = await db.all<RecordDb>(
        `SELECT * FROM driveshare_meeting_attendance WHERE org_id = ? AND occurrence_date >= ? AND occurrence_date <= ?`,
        orgId, from, to,
      );
      return rows.map(toRecord);
    },

    async replaceParticipants(orgId, meetingId, date, rows) {
      await db.batch([
        {
          sql: `DELETE FROM driveshare_meet_participants WHERE org_id = ? AND meeting_id = ? AND occurrence_date = ?`,
          binds: [orgId, meetingId, date],
        },
        ...rows.map((p) => ({
          sql: `INSERT OR REPLACE INTO driveshare_meet_participants
                  (meeting_id, occurrence_date, participant_key, org_id, kind, google_user_id, display_name,
                   first_join, last_leave, duration_seconds, approx, ingested_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          binds: [
            p.meetingId, p.occurrenceDate, p.participantKey, p.orgId, p.kind, p.googleUserId, p.displayName,
            p.firstJoin, p.lastLeave, p.durationSeconds, p.approx ? 1 : 0, p.ingestedAt,
          ],
        })),
      ]);
    },
    async listParticipants(orgId, from, to) {
      const rows = await db.all<ParticipantDb>(
        `SELECT * FROM driveshare_meet_participants WHERE org_id = ? AND occurrence_date >= ? AND occurrence_date <= ?`,
        orgId, from, to,
      );
      return rows.map(toParticipant);
    },

    async getIngest(meetingId, date) {
      const r = await db.first<IngestDb>(`SELECT * FROM driveshare_meet_ingests WHERE meeting_id = ? AND occurrence_date = ?`, meetingId, date);
      return r ? toIngest(r) : null;
    },
    async putIngest(i) {
      await db.run(
        `INSERT OR REPLACE INTO driveshare_meet_ingests
           (meeting_id, occurrence_date, org_id, status, conferences, participants, attempts, last_error, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        i.meetingId, i.occurrenceDate, i.orgId, i.status, i.conferences, i.participants, i.attempts, i.lastError, i.ingestedAt,
      );
    },
    async listIngests(orgId, from, to) {
      const rows = await db.all<IngestDb>(
        `SELECT * FROM driveshare_meet_ingests WHERE org_id = ? AND occurrence_date >= ? AND occurrence_date <= ?`,
        orgId, from, to,
      );
      return rows.map(toIngest);
    },
    async lastIngestAt(orgId) {
      const r = await db.first<{ at: string | null }>(`SELECT MAX(ingested_at) AS at FROM driveshare_meet_ingests WHERE org_id = ?`, orgId);
      return r?.at ?? null;
    },

    async listLinks(orgId) {
      const rows = await db.all<{ org_id: string; google_user_id: string; user_id: string; source: string; linked_by: string; linked_at: string }>(
        `SELECT * FROM driveshare_google_identity_links WHERE org_id = ?`,
        orgId,
      );
      return rows.map((r) => ({
        orgId: r.org_id,
        googleUserId: r.google_user_id,
        userId: r.user_id,
        source: r.source as LinkRow["source"],
        linkedBy: r.linked_by,
        linkedAt: r.linked_at,
      }));
    },
    async putLink(l) {
      await db.run(
        `INSERT OR REPLACE INTO driveshare_google_identity_links (org_id, google_user_id, user_id, source, linked_by, linked_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        l.orgId, l.googleUserId, l.userId, l.source, l.linkedBy, l.linkedAt,
      );
    },
    async removeLink(orgId, googleUserId) {
      await db.run(`DELETE FROM driveshare_google_identity_links WHERE org_id = ? AND google_user_id = ?`, orgId, googleUserId);
    },

    async getMinPercent(orgId) {
      const r = await db.first<{ min_percent: number }>(`SELECT min_percent FROM driveshare_attendance_settings WHERE org_id = ?`, orgId);
      return r ? Number(r.min_percent) : null;
    },
    async setMinPercent(orgId, minPercent, by, at) {
      await db.run(
        `INSERT OR REPLACE INTO driveshare_attendance_settings (org_id, min_percent, updated_by, updated_at) VALUES (?, ?, ?, ?)`,
        orgId, minPercent, by, at,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory (unit tests)
// ---------------------------------------------------------------------------

export function createInMemoryAttendanceStore() {
  const regulars = new Map<string, string>(); // meetingId -> orgId
  const records = new Map<string, AttendanceRow>();
  const participants = new Map<string, ParticipantRow>();
  const ingests = new Map<string, IngestRow>();
  const links = new Map<string, LinkRow>();
  const settings = new Map<string, number>();
  const rk = (m: string, d: string, u: string, s: string) => `${m}|${d}|${u}|${s}`;
  const inRange = (orgId: string, from: string, to: string) => (r: { orgId: string; occurrenceDate: string }) =>
    r.orgId === orgId && r.occurrenceDate >= from && r.occurrenceDate <= to;
  const store: AttendanceStore & {
    regulars: typeof regulars;
    records: typeof records;
    participants: typeof participants;
    ingests: typeof ingests;
    links: typeof links;
  } = {
    regulars,
    records,
    participants,
    ingests,
    links,
    async listRegularIds(orgId) {
      return new Set([...regulars].filter(([, o]) => o === orgId).map(([id]) => id));
    },
    async setRegular(orgId, meetingId, enabled) {
      if (enabled) regulars.set(meetingId, orgId);
      else regulars.delete(meetingId);
    },
    async getRecord(m, d, u, s) {
      const r = records.get(rk(m, d, u, s));
      return r ? { ...r } : null;
    },
    async upsertRecord(a) {
      records.set(rk(a.meetingId, a.occurrenceDate, a.userId, a.source), { ...a });
    },
    async removeRecord(m, d, u, s) {
      records.delete(rk(m, d, u, s));
    },
    async listRecords(orgId, from, to) {
      return [...records.values()].filter(inRange(orgId, from, to)).map((r) => ({ ...r }));
    },
    async replaceParticipants(orgId, meetingId, date, rows) {
      for (const [k, p] of participants) if (p.orgId === orgId && p.meetingId === meetingId && p.occurrenceDate === date) participants.delete(k);
      for (const p of rows) participants.set(`${p.meetingId}|${p.occurrenceDate}|${p.participantKey}`, { ...p });
    },
    async listParticipants(orgId, from, to) {
      return [...participants.values()].filter(inRange(orgId, from, to)).map((p) => ({ ...p }));
    },
    async getIngest(m, d) {
      const r = ingests.get(`${m}|${d}`);
      return r ? { ...r } : null;
    },
    async putIngest(i) {
      ingests.set(`${i.meetingId}|${i.occurrenceDate}`, { ...i });
    },
    async listIngests(orgId, from, to) {
      return [...ingests.values()].filter(inRange(orgId, from, to)).map((r) => ({ ...r }));
    },
    async lastIngestAt(orgId) {
      const all = [...ingests.values()].filter((i) => i.orgId === orgId).map((i) => i.ingestedAt).sort();
      return all.at(-1) ?? null;
    },
    async listLinks(orgId) {
      return [...links.values()].filter((l) => l.orgId === orgId).map((l) => ({ ...l }));
    },
    async putLink(l) {
      links.set(`${l.orgId}|${l.googleUserId}`, { ...l });
    },
    async removeLink(orgId, googleUserId) {
      links.delete(`${orgId}|${googleUserId}`);
    },
    async getMinPercent(orgId) {
      return settings.get(orgId) ?? null;
    },
    async setMinPercent(orgId, minPercent) {
      settings.set(orgId, minPercent);
    },
  };
  return store;
}
