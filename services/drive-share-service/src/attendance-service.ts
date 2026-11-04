// 定例の出席 (全体定例 / チーム定例). A meeting marked trackAttendance is a 定例; a member who opens
// its Meet from Dub (POST /meetings/:id/join) during an occurrence — from JOIN_WINDOW_BEFORE_MINUTES
// before the start until the end — is recorded present for that occurrence (its JST date). 人事 reads
// the report (who attended / who was expected, rate per member) and can correct it by hand.
//
// Why "join from Dub" and not Google's participant list: reading Meet conference records needs a
// further Google scope (meetings.space.readonly) on the shared account, which Dub does not ask for.
// Expected members = the target's CURRENT active members (role membership is not historised).
import { errors } from "@dub/errors";
import { meeting } from "@dub/types";
import type { AttendanceRow, AttendanceStore } from "./attendance-store";
import { jstDate } from "./meeting-rules";
import type { MeetingRow, MeetingStore } from "./meetings-store";
import type { ActiveUser, RoleMembership } from "./role-membership";

const MS_PER_DAY = 86_400_000;
const DEFAULT_RANGE_DAYS = 84;
const MAX_RANGE_DAYS = 366;
/** How far ahead "next occurrence" looks (a monthly meeting always has one within this). */
const NEXT_LOOKAHEAD_DAYS = 62;
const ALL_TARGET_NAME = "全体";

export interface AttendanceDeps {
  meetings: MeetingStore;
  store: AttendanceStore;
  roster: RoleMembership;
  orgId: string;
  now: () => string;
}

export interface AttendanceService {
  join(userId: string, meetingId: string): Promise<meeting.JoinMeetingResponse>;
  myRegulars(userId: string): Promise<meeting.ListMyRegularMeetingsResponse>;
  report(query: { from?: string; to?: string }): Promise<meeting.AttendanceReportResponse>;
  set(by: string, meetingId: string, date: string, userId: string, body: unknown): Promise<meeting.SetAttendanceResponse>;
}

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
const isDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && addDays(v, 0) === v;

/** The occurrence open for joining at `nowIso` (window: 30 min before start .. end), or null. */
export function openOccurrence(
  m: Pick<MeetingRow, "startsAt" | "recurrence" | "until" | "durationMinutes">,
  nowIso: string,
): meeting.OccurrenceStart | null {
  const now = Date.parse(nowIso);
  const today = jstDate(nowIso);
  const before = meeting.JOIN_WINDOW_BEFORE_MINUTES * 60_000;
  for (const o of meeting.occurrenceStarts(m, addDays(today, -1), addDays(today, 1))) {
    const start = Date.parse(o.startsAt);
    if (now >= start - before && now <= start + m.durationMinutes * 60_000) return o;
  }
  return null;
}

function toRecord(r: AttendanceRow): meeting.AttendanceRecord {
  return { userId: r.userId, status: r.status, source: r.source, joinedAt: r.joinedAt, recordedBy: r.recordedBy, updatedAt: r.updatedAt };
}

export function createAttendanceService(deps: AttendanceDeps): AttendanceService {
  const { orgId } = deps;

  const expectedOf = (users: ActiveUser[], targetId: string) =>
    targetId === meeting.ALL_MEMBERS_TARGET_ID ? users : users.filter((u) => u.roleIds.includes(targetId));

  /** Role names, best-effort (needs identity:read of the caller; a failure just shows the id). */
  async function names(): Promise<Map<string, string>> {
    try {
      return new Map((await deps.roster.listRoles()).map((r) => [r.id, r.name]));
    } catch {
      return new Map();
    }
  }
  const targetName = (targetId: string, n: Map<string, string>) =>
    targetId === meeting.ALL_MEMBERS_TARGET_ID ? ALL_TARGET_NAME : n.get(targetId) ?? "（削除されたロール）";

  async function regularMeetings(): Promise<MeetingRow[]> {
    const ids = await deps.store.listRegularIds(orgId);
    if (ids.size === 0) return [];
    return (await deps.meetings.listMeetings(orgId)).filter((m) => ids.has(m.id));
  }

  return {
    async join(userId, meetingId) {
      const m = await deps.meetings.getMeeting(orgId, meetingId);
      if (!m) throw errors.notFound("meeting", meetingId);
      // Instance check (the route is AUTHENTICATED): only the meeting's own members may join through Dub.
      const users = await deps.roster.listActiveUsers(m.targetId === meeting.ALL_MEMBERS_TARGET_ID ? undefined : m.targetId);
      if (!users.some((u) => u.id === userId)) throw errors.forbidden("この定例の対象メンバーではありません。");
      const regular = (await deps.store.listRegularIds(orgId)).has(m.id);
      const now = deps.now();
      const occ = regular ? openOccurrence(m, now) : null;
      if (!occ) return { meetUrl: m.meetUrl, recordedFor: null };
      const existing = await deps.store.get(m.id, occ.date, userId);
      if (existing?.status !== "present") {
        await deps.store.upsert({
          meetingId: m.id,
          occurrenceDate: occ.date,
          userId,
          orgId,
          status: "present",
          source: "join",
          joinedAt: existing?.joinedAt ?? now,
          recordedBy: userId,
          updatedAt: now,
        });
      } else if (!existing.joinedAt) {
        // 人事 marked present by hand before: keep it, just note the real join.
        await deps.store.upsert({ ...existing, joinedAt: now });
      }
      return { meetUrl: m.meetUrl, recordedFor: occ.date };
    },

    async myRegulars(userId) {
      const rows = await regularMeetings();
      if (rows.length === 0) return { items: [] };
      const me = (await deps.roster.listActiveUsers()).find((u) => u.id === userId);
      if (!me) return { items: [] };
      const mine = rows.filter((m) => m.targetId === meeting.ALL_MEMBERS_TARGET_ID || me.roleIds.includes(m.targetId));
      const n = mine.some((m) => m.targetId !== meeting.ALL_MEMBERS_TARGET_ID) ? await names() : new Map<string, string>();
      const now = deps.now();
      const today = jstDate(now);
      const items: meeting.MyRegularMeeting[] = [];
      for (const m of mine) {
        const open = openOccurrence(m, now);
        const next =
          open ?? meeting.occurrenceStarts(m, today, addDays(today, NEXT_LOOKAHEAD_DAYS)).find((o) => Date.parse(o.startsAt) > Date.parse(now)) ?? null;
        const rec = open ? await deps.store.get(m.id, open.date, userId) : null;
        items.push({
          id: m.id,
          title: m.title,
          targetName: targetName(m.targetId, n),
          kind: meeting.regularKindOf(m.targetId),
          meetUrl: m.meetUrl,
          next,
          durationMinutes: m.durationMinutes,
          joinOpen: !!open,
          attended: rec?.status === "present",
        });
      }
      // Open now first, then soonest; ended series last.
      items.sort((a, b) => Number(b.joinOpen) - Number(a.joinOpen) || (a.next?.startsAt ?? "~").localeCompare(b.next?.startsAt ?? "~"));
      return { items };
    },

    async report(query) {
      const now = deps.now();
      const to = query.to ?? jstDate(now);
      const from = query.from ?? (isDate(to) ? addDays(to, -(DEFAULT_RANGE_DAYS - 1)) : "");
      if (!isDate(from) || !isDate(to)) {
        throw errors.validationFailed([{ field: "from", reason: "invalid" }], "期間の形式が正しくありません（YYYY-MM-DD）。");
      }
      if (from > to || addDays(from, MAX_RANGE_DAYS) < to) {
        throw errors.validationFailed([{ field: "from", reason: "out_of_range" }], `期間は開始日〜終了日の順で、${MAX_RANGE_DAYS} 日以内にしてください。`);
      }
      const rows = await regularMeetings();
      if (rows.length === 0) return { from, to, meetings: [], members: [] };
      const [users, n, records] = await Promise.all([deps.roster.listActiveUsers(), names(), deps.store.listRange(orgId, from, to)]);
      const byOcc = new Map<string, AttendanceRow[]>();
      for (const r of records) {
        const k = `${r.meetingId}|${r.occurrenceDate}`;
        byOcc.set(k, [...(byOcc.get(k) ?? []), r]);
      }
      const tally = new Map<string, { expected: number; present: number; excused: number }>();
      const nowMs = Date.parse(now);
      const meetings: meeting.AttendanceMeeting[] = rows.map((m) => {
        const expected = expectedOf(users, m.targetId);
        const expectedIds = new Set(expected.map((u) => u.id));
        const occurrences = meeting
          .occurrenceStarts(m, from, to)
          .filter((o) => Date.parse(o.startsAt) <= nowMs)
          .reverse()
          .map((o) => ({ ...o, records: (byOcc.get(`${m.id}|${o.date}`) ?? []).map(toRecord) }));
        for (const u of expected) {
          const t = tally.get(u.id) ?? { expected: 0, present: 0, excused: 0 };
          t.expected += occurrences.length;
          tally.set(u.id, t);
        }
        for (const o of occurrences) {
          for (const r of o.records) {
            const t = expectedIds.has(r.userId) ? tally.get(r.userId) : undefined;
            if (!t) continue; // not (or no longer) expected: shown on the occurrence, not in the rate
            if (r.status === "present") t.present++;
            else t.excused++;
          }
        }
        return {
          id: m.id,
          title: m.title,
          targetId: m.targetId,
          targetName: targetName(m.targetId, n),
          kind: meeting.regularKindOf(m.targetId),
          durationMinutes: m.durationMinutes,
          recurrence: m.recurrence,
          expectedUserIds: expected.map((u) => u.id),
          occurrences,
        };
      });
      const members: meeting.AttendanceMember[] = users
        .filter((u) => tally.has(u.id))
        .map((u) => {
          const t = tally.get(u.id)!;
          const denom = t.expected - t.excused;
          return { userId: u.id, name: u.name, email: u.email, ...t, rate: denom > 0 ? t.present / denom : null };
        })
        .sort((a, b) => (a.rate ?? 2) - (b.rate ?? 2) || a.name.localeCompare(b.name, "ja"));
      return { from, to, meetings, members };
    },

    async set(by, meetingId, date, userId, body) {
      const raw = body && typeof body === "object" ? (body as { status?: unknown }).status : undefined;
      if (raw !== null && !(meeting.ATTENDANCE_STATUSES as readonly unknown[]).includes(raw)) {
        throw errors.validationFailed([{ field: "status", reason: "invalid" }], "出席の状態が正しくありません。");
      }
      const status = raw as meeting.AttendanceStatus | null;
      const m = await deps.meetings.getMeeting(orgId, meetingId);
      if (!m) throw errors.notFound("meeting", meetingId);
      if (!isDate(date) || meeting.occurrenceStarts(m, date, date).length === 0) {
        throw errors.validationFailed([{ field: "date", reason: "not_an_occurrence" }], "その日はこの定例の開催日ではありません。");
      }
      const existing = await deps.store.get(m.id, date, userId);
      if (status === null) {
        await deps.store.remove(m.id, date, userId);
        return { record: null };
      }
      const users = expectedOf(await deps.roster.listActiveUsers(), m.targetId);
      if (!existing && !users.some((u) => u.id === userId)) {
        throw errors.validationFailed([{ field: "userId", reason: "not_expected" }], "この定例の対象メンバーではありません。");
      }
      const row: AttendanceRow = {
        meetingId: m.id,
        occurrenceDate: date,
        userId,
        orgId,
        status,
        source: "manual",
        joinedAt: existing?.joinedAt ?? null,
        recordedBy: by,
        updatedAt: deps.now(),
      };
      await deps.store.upsert(row);
      return { record: toRecord(row) };
    },
  };
}
