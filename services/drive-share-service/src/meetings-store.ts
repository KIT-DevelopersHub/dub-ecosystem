// Persistence for カレンダー > ミーティング (driveshare/0003): per-target calendars, meetings, and the
// two provenance ledgers — attendees we invited and calendar shares (ACL rules) we created — so
// reconcile only ever removes what it added. D1 in production, in-memory for unit tests (same
// observable semantics, mirroring role-grants-store.ts). Timestamps are service-set (nowIso).
import type { DbClient } from "@dub/db";
import { meeting } from "@dub/types";

export interface MeetingCalendarRow {
  orgId: string;
  targetId: string;
  accountId: string;
  calendarId: string;
  createdAt: string;
}

export interface MeetingRow {
  id: string;
  orgId: string;
  /** The calendar's target (meeting.calendarTargetOf(targets)); also what an older worker reads. */
  targetId: string;
  /** Who is invited (driveshare_meeting_targets, 0006). A meeting without rows there — made before
   *  0006 or by an older worker — reads as legacyTargets(targetId). */
  targets: meeting.MeetingTargetRef[];
  accountId: string;
  calendarId: string;
  googleEventId: string;
  title: string;
  description: string | null;
  startsAt: string;
  durationMinutes: number;
  recurrence: meeting.MeetingRecurrence;
  until: string | null;
  meetUrl: string | null;
  htmlLink: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  syncedAt: string | null;
}

export interface MeetingInviteRow {
  meetingId: string;
  /** Lowercased address. */
  email: string;
  userId: string | null;
}

export interface MeetingAclRow {
  orgId: string;
  calendarId: string;
  email: string;
  ruleId: string;
}

export interface MeetingStore {
  getCalendar(orgId: string, targetId: string, accountId: string): Promise<MeetingCalendarRow | null>;
  /** First writer wins (UNIQUE org/target/account); returns the stored row. */
  insertCalendar(row: MeetingCalendarRow): Promise<MeetingCalendarRow>;
  listCalendars(orgId: string, accountId: string): Promise<MeetingCalendarRow[]>;

  listMeetings(orgId: string): Promise<MeetingRow[]>;
  getMeeting(orgId: string, id: string): Promise<MeetingRow | null>;
  insertMeeting(row: MeetingRow): Promise<void>;
  updateMeeting(row: MeetingRow): Promise<void>;
  /** updateMeeting only while the stored updated_at is still `expectedUpdatedAt` (the sync must not
   *  overwrite a user edit that landed after it read the row). false = skipped. */
  updateMeetingIf(row: MeetingRow, expectedUpdatedAt: string): Promise<boolean>;
  /** insertMeeting / updateMeeting also write `targets`; updateMeetingIf leaves them alone. */
  /** Deletes the meeting, its targets and its invite ledger. */
  deleteMeeting(id: string): Promise<void>;
  /** deleteMeeting only while it still points at that event (not moved meanwhile). false = skipped. */
  deleteMeetingIf(id: string, calendarId: string, googleEventId: string): Promise<boolean>;

  listInvites(meetingId: string): Promise<MeetingInviteRow[]>;
  replaceInvites(meetingId: string, rows: readonly MeetingInviteRow[]): Promise<void>;
  /** meetingId -> number of invites we hold, for every meeting of the org. */
  inviteCounts(orgId: string): Promise<Map<string, number>>;

  listAcl(orgId: string, calendarId: string): Promise<MeetingAclRow[]>;
  putAcl(row: MeetingAclRow): Promise<void>;
  removeAcl(orgId: string, calendarId: string, email: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

interface MeetingDbRow {
  id: string;
  org_id: string;
  target_id: string;
  account_id: string;
  calendar_id: string;
  google_event_id: string;
  title: string;
  description: string | null;
  starts_at: string;
  duration_minutes: number;
  recurrence: string;
  until: string | null;
  meet_url: string | null;
  html_link: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

function toMeetingRow(r: MeetingDbRow, targets: meeting.MeetingTargetRef[] | undefined): MeetingRow {
  return {
    id: r.id,
    orgId: r.org_id,
    targetId: r.target_id,
    targets: targets && targets.length > 0 ? targets : meeting.legacyTargets(r.target_id),
    accountId: r.account_id,
    calendarId: r.calendar_id,
    googleEventId: r.google_event_id,
    title: r.title,
    description: r.description,
    startsAt: r.starts_at,
    durationMinutes: Number(r.duration_minutes),
    recurrence: r.recurrence as meeting.MeetingRecurrence,
    until: r.until,
    meetUrl: r.meet_url,
    htmlLink: r.html_link,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    syncedAt: r.synced_at,
  };
}

interface TargetDbRow {
  meeting_id: string;
  kind: string;
  target_id: string;
}

function groupTargets(rows: TargetDbRow[]): Map<string, meeting.MeetingTargetRef[]> {
  const out = new Map<string, meeting.MeetingTargetRef[]>();
  for (const r of rows) {
    if (!meeting.MEETING_TARGET_KINDS.includes(r.kind as meeting.MeetingTargetKind)) continue;
    out.set(r.meeting_id, [...(out.get(r.meeting_id) ?? []), { kind: r.kind as meeting.MeetingTargetKind, id: r.target_id }]);
  }
  return out;
}

const insertTargets = (m: MeetingRow) =>
  m.targets.map((t, i) => ({
    sql: `INSERT OR REPLACE INTO driveshare_meeting_targets (org_id, meeting_id, kind, target_id, position) VALUES (?, ?, ?, ?, ?)`,
    binds: [m.orgId, m.id, t.kind, t.id, i],
  }));

interface CalendarDbRow {
  org_id: string;
  target_id: string;
  account_id: string;
  calendar_id: string;
  created_at: string;
}
const toCalendarRow = (r: CalendarDbRow): MeetingCalendarRow => ({
  orgId: r.org_id,
  targetId: r.target_id,
  accountId: r.account_id,
  calendarId: r.calendar_id,
  createdAt: r.created_at,
});

export function createD1MeetingStore(db: DbClient): MeetingStore {
  async function getCalendar(orgId: string, targetId: string, accountId: string): Promise<MeetingCalendarRow | null> {
    const r = await db.first<CalendarDbRow>(
      `SELECT * FROM driveshare_meeting_calendars WHERE org_id = ? AND target_id = ? AND account_id = ?`,
      orgId, targetId, accountId,
    );
    return r ? toCalendarRow(r) : null;
  }

  return {
    getCalendar,
    async insertCalendar(row) {
      await db.run(
        `INSERT OR IGNORE INTO driveshare_meeting_calendars (org_id, target_id, account_id, calendar_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        row.orgId, row.targetId, row.accountId, row.calendarId, row.createdAt,
      );
      return (await getCalendar(row.orgId, row.targetId, row.accountId)) ?? row;
    },
    async listCalendars(orgId, accountId) {
      const rows = await db.all<CalendarDbRow>(
        `SELECT * FROM driveshare_meeting_calendars WHERE org_id = ? AND account_id = ? ORDER BY created_at ASC`,
        orgId, accountId,
      );
      return rows.map(toCalendarRow);
    },

    async listMeetings(orgId) {
      const [rows, targets] = await Promise.all([
        db.all<MeetingDbRow>(`SELECT * FROM driveshare_meetings WHERE org_id = ? ORDER BY starts_at ASC, id ASC`, orgId),
        db.all<TargetDbRow>(`SELECT * FROM driveshare_meeting_targets WHERE org_id = ? ORDER BY meeting_id ASC, position ASC`, orgId),
      ]);
      const byMeeting = groupTargets(targets);
      return rows.map((r) => toMeetingRow(r, byMeeting.get(r.id)));
    },
    async getMeeting(orgId, id) {
      const r = await db.first<MeetingDbRow>(`SELECT * FROM driveshare_meetings WHERE org_id = ? AND id = ?`, orgId, id);
      if (!r) return null;
      const targets = await db.all<TargetDbRow>(`SELECT * FROM driveshare_meeting_targets WHERE meeting_id = ? ORDER BY position ASC`, id);
      return toMeetingRow(r, groupTargets(targets).get(id));
    },
    async insertMeeting(m) {
      await db.batch([
        {
          sql: `INSERT INTO driveshare_meetings
                  (id, org_id, target_id, account_id, calendar_id, google_event_id, title, description, starts_at,
                   duration_minutes, recurrence, until, meet_url, html_link, created_by, created_at, updated_at, synced_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          binds: [
            m.id, m.orgId, m.targetId, m.accountId, m.calendarId, m.googleEventId, m.title, m.description, m.startsAt,
            m.durationMinutes, m.recurrence, m.until, m.meetUrl, m.htmlLink, m.createdBy, m.createdAt, m.updatedAt, m.syncedAt,
          ],
        },
        ...insertTargets(m),
      ]);
    },
    async updateMeeting(m) {
      await db.batch([
        {
          sql: `UPDATE driveshare_meetings SET
                  target_id = ?, account_id = ?, calendar_id = ?, google_event_id = ?, title = ?, description = ?,
                  starts_at = ?, duration_minutes = ?, recurrence = ?, until = ?, meet_url = ?, html_link = ?,
                  updated_at = ?, synced_at = ?
                WHERE id = ?`,
          binds: [
            m.targetId, m.accountId, m.calendarId, m.googleEventId, m.title, m.description,
            m.startsAt, m.durationMinutes, m.recurrence, m.until, m.meetUrl, m.htmlLink,
            m.updatedAt, m.syncedAt, m.id,
          ],
        },
        { sql: `DELETE FROM driveshare_meeting_targets WHERE meeting_id = ?`, binds: [m.id] },
        ...insertTargets(m),
      ]);
    },
    async updateMeetingIf(m, expectedUpdatedAt) {
      const r = await db.run(
        `UPDATE driveshare_meetings SET
           target_id = ?, account_id = ?, calendar_id = ?, google_event_id = ?, title = ?, description = ?,
           starts_at = ?, duration_minutes = ?, recurrence = ?, until = ?, meet_url = ?, html_link = ?,
           updated_at = ?, synced_at = ?
         WHERE id = ? AND updated_at = ?`,
        m.targetId, m.accountId, m.calendarId, m.googleEventId, m.title, m.description,
        m.startsAt, m.durationMinutes, m.recurrence, m.until, m.meetUrl, m.htmlLink,
        m.updatedAt, m.syncedAt, m.id, expectedUpdatedAt,
      );
      return r.meta.changes > 0;
    },
    async deleteMeeting(id) {
      await db.run(`DELETE FROM driveshare_meeting_targets WHERE meeting_id = ?`, id);
      await db.run(`DELETE FROM driveshare_meeting_invites WHERE meeting_id = ?`, id);
      await db.run(`DELETE FROM driveshare_meetings WHERE id = ?`, id);
    },
    async deleteMeetingIf(id, calendarId, googleEventId) {
      // Invites first (they reference the meeting: FK), all in one batch = one transaction.
      const [, , r] = await db.batch([
        {
          sql: `DELETE FROM driveshare_meeting_targets WHERE meeting_id = ? AND EXISTS
                  (SELECT 1 FROM driveshare_meetings WHERE id = ? AND calendar_id = ? AND google_event_id = ?)`,
          binds: [id, id, calendarId, googleEventId],
        },
        {
          sql: `DELETE FROM driveshare_meeting_invites WHERE meeting_id = ? AND EXISTS
                  (SELECT 1 FROM driveshare_meetings WHERE id = ? AND calendar_id = ? AND google_event_id = ?)`,
          binds: [id, id, calendarId, googleEventId],
        },
        {
          sql: `DELETE FROM driveshare_meetings WHERE id = ? AND calendar_id = ? AND google_event_id = ?`,
          binds: [id, calendarId, googleEventId],
        },
      ]);
      return (r?.meta.changes ?? 0) > 0;
    },

    async listInvites(meetingId) {
      const rows = await db.all<{ meeting_id: string; email: string; user_id: string | null }>(
        `SELECT * FROM driveshare_meeting_invites WHERE meeting_id = ? ORDER BY email ASC`,
        meetingId,
      );
      return rows.map((r) => ({ meetingId: r.meeting_id, email: r.email, userId: r.user_id }));
    },
    async replaceInvites(meetingId, rows) {
      await db.batch([
        { sql: `DELETE FROM driveshare_meeting_invites WHERE meeting_id = ?`, binds: [meetingId] },
        ...rows.map((r) => ({
          sql: `INSERT OR REPLACE INTO driveshare_meeting_invites (meeting_id, email, user_id) VALUES (?, ?, ?)`,
          binds: [meetingId, r.email, r.userId],
        })),
      ]);
    },
    async inviteCounts(orgId) {
      const rows = await db.all<{ meeting_id: string; n: number }>(
        `SELECT i.meeting_id AS meeting_id, COUNT(*) AS n FROM driveshare_meeting_invites i
           JOIN driveshare_meetings m ON m.id = i.meeting_id
          WHERE m.org_id = ? GROUP BY i.meeting_id`,
        orgId,
      );
      return new Map(rows.map((r) => [r.meeting_id, Number(r.n)]));
    },

    async listAcl(orgId, calendarId) {
      const rows = await db.all<{ org_id: string; calendar_id: string; email: string; rule_id: string }>(
        `SELECT * FROM driveshare_meeting_calendar_acl WHERE org_id = ? AND calendar_id = ? ORDER BY email ASC`,
        orgId, calendarId,
      );
      return rows.map((r) => ({ orgId: r.org_id, calendarId: r.calendar_id, email: r.email, ruleId: r.rule_id }));
    },
    async putAcl(row) {
      await db.run(
        `INSERT OR REPLACE INTO driveshare_meeting_calendar_acl (org_id, calendar_id, email, rule_id) VALUES (?, ?, ?, ?)`,
        row.orgId, row.calendarId, row.email, row.ruleId,
      );
    },
    async removeAcl(orgId, calendarId, email) {
      await db.run(
        `DELETE FROM driveshare_meeting_calendar_acl WHERE org_id = ? AND calendar_id = ? AND email = ?`,
        orgId, calendarId, email,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory (unit tests)
// ---------------------------------------------------------------------------

export function createInMemoryMeetingStore(): MeetingStore & {
  meetings: Map<string, MeetingRow>;
  invites: Map<string, MeetingInviteRow[]>;
  acl: MeetingAclRow[];
} {
  const calendars: MeetingCalendarRow[] = [];
  const meetings = new Map<string, MeetingRow>();
  const invites = new Map<string, MeetingInviteRow[]>();
  const store = {
    meetings,
    invites,
    acl: [] as MeetingAclRow[],
    async getCalendar(orgId: string, targetId: string, accountId: string) {
      const c = calendars.find((r) => r.orgId === orgId && r.targetId === targetId && r.accountId === accountId);
      return c ? { ...c } : null;
    },
    async insertCalendar(row: MeetingCalendarRow) {
      const existing = await store.getCalendar(row.orgId, row.targetId, row.accountId);
      if (existing) return existing;
      calendars.push({ ...row });
      return { ...row };
    },
    async listCalendars(orgId: string, accountId: string) {
      return calendars.filter((r) => r.orgId === orgId && r.accountId === accountId).map((r) => ({ ...r }));
    },
    async listMeetings(orgId: string) {
      return [...meetings.values()]
        .filter((m) => m.orgId === orgId)
        .sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : a.id.localeCompare(b.id)))
        .map((m) => ({ ...m }));
    },
    async getMeeting(orgId: string, id: string) {
      const m = meetings.get(id);
      return m && m.orgId === orgId ? { ...m } : null;
    },
    async insertMeeting(row: MeetingRow) {
      meetings.set(row.id, { ...row, targets: [...row.targets] });
    },
    async updateMeeting(row: MeetingRow) {
      if (meetings.has(row.id)) meetings.set(row.id, { ...row, targets: [...row.targets] });
    },
    async updateMeetingIf(row: MeetingRow, expectedUpdatedAt: string) {
      const stored = meetings.get(row.id);
      if (stored?.updatedAt !== expectedUpdatedAt) return false;
      meetings.set(row.id, { ...row, targets: stored.targets }); // as D1: targets untouched
      return true;
    },
    async deleteMeeting(id: string) {
      meetings.delete(id);
      invites.delete(id);
    },
    async deleteMeetingIf(id: string, calendarId: string, googleEventId: string) {
      const m = meetings.get(id);
      if (!m || m.calendarId !== calendarId || m.googleEventId !== googleEventId) return false;
      meetings.delete(id);
      invites.delete(id);
      return true;
    },
    async listInvites(meetingId: string) {
      return (invites.get(meetingId) ?? []).map((r) => ({ ...r })).sort((a, b) => a.email.localeCompare(b.email));
    },
    async replaceInvites(meetingId: string, rows: readonly MeetingInviteRow[]) {
      invites.set(meetingId, rows.map((r) => ({ ...r })));
    },
    async inviteCounts(orgId: string) {
      const out = new Map<string, number>();
      for (const [id, rows] of invites) if (meetings.get(id)?.orgId === orgId) out.set(id, rows.length);
      return out;
    },
    async listAcl(orgId: string, calendarId: string) {
      return store.acl.filter((r) => r.orgId === orgId && r.calendarId === calendarId).map((r) => ({ ...r }));
    },
    async putAcl(row: MeetingAclRow) {
      store.acl = store.acl.filter((r) => !(r.orgId === row.orgId && r.calendarId === row.calendarId && r.email === row.email));
      store.acl.push({ ...row });
    },
    async removeAcl(orgId: string, calendarId: string, email: string) {
      store.acl = store.acl.filter((r) => !(r.orgId === orgId && r.calendarId === calendarId && r.email === email));
    },
  };
  return store;
}
