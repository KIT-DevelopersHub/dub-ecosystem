// 定例の出席 (全体定例 / チーム定例). A meeting marked trackAttendance is a 定例. Attendance per member
// per occurrence is derived at read time, strongest signal first:
//   manual   — 人事 set it (stored record, source 'manual')
//   meet_api — Google Meet participant records (ingested by meet-ingest.ts), matched to the member by
//              Google account id through driveshare_google_identity_links ('self' = the member's own
//              「Googleと連携」, 'confirmed' = 人事 confirmed the participant once). Present when the
//              member was in the Meet ≥ minPercent of the scheduled length, else absent.
//   join     — the member opened the Meet from Dub during the occurrence (stored, source 'join');
//              counts only when Meet has no matched participant for them.
// Expected members = the target's CURRENT active members (role membership is not historised).
import { errors } from "@dub/errors";
import { meeting } from "@dub/types";
import type { AttendanceRow, AttendanceStore, ParticipantRow } from "./attendance-store";
import type { MeetRecordsClient } from "./google/meet-records-client";
import { runMeetIngest } from "./meet-ingest";
import { jstDate } from "./meeting-rules";
import type { MeetingRow, MeetingStore } from "./meetings-store";
import { describeTargets, targetsLabel } from "./meetings-service";
import type { ActiveUser, RoleMembership } from "./role-membership";

const MS_PER_DAY = 86_400_000;
const DEFAULT_RANGE_DAYS = 84;
const MAX_RANGE_DAYS = 366;
/** How far ahead "next occurrence" looks (a monthly meeting always has one within this). */
const NEXT_LOOKAHEAD_DAYS = 62;
/** Google calls of a manual 「今すぐ取り込む」 (request path: the gateway gives 15 s). */
const MANUAL_INGEST_BUDGET = 25;
const MANUAL_INGEST_TIME_MS = 9_000;

/** The shared Google account as attendance needs it. null = nothing usable (no account / mock off). */
export interface MeetRecordsAccess {
  /** false = the grant lacks meetings.space.readonly. */
  ready: boolean;
  client: MeetRecordsClient;
}

export interface AttendanceDeps {
  meetings: MeetingStore;
  store: AttendanceStore;
  roster: RoleMembership;
  orgId: string;
  now: () => string;
  meetRecords: () => Promise<MeetRecordsAccess | null>;
  /** Pull the scheduled job (MeetingSyncDO alarm) earlier — continues an unfinished manual ingest. */
  kick?: (soonMs?: number) => Promise<void>;
}

export interface AttendanceService {
  join(userId: string, meetingId: string): Promise<meeting.JoinMeetingResponse>;
  myRegulars(userId: string): Promise<meeting.ListMyRegularMeetingsResponse>;
  report(query: { from?: string; to?: string }): Promise<meeting.AttendanceReportResponse>;
  set(by: string, meetingId: string, date: string, userId: string, body: unknown): Promise<meeting.SetAttendanceResponse>;
  confirm(by: string, googleUserId: string, body: unknown): Promise<{ ok: true }>;
  unlink(googleUserId: string): Promise<{ ok: true }>;
  updateSettings(by: string, body: unknown): Promise<meeting.AttendanceSettings>;
  ingest(body: unknown): Promise<meeting.IngestAttendanceResponse>;
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

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s・._\-()（）]/g, "");

/** Members whose name looks like a Meet display name, best first (max 3). */
export function suggestMembers(displayName: string, candidates: readonly { id: string; name: string }[]): { userId: string; name: string }[] {
  const d = norm(displayName);
  const dTokens = displayName.normalize("NFKC").toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  const scored = candidates
    .map((c) => {
      const n = norm(c.name);
      let score = 0;
      if (!n || !d) score = 0;
      else if (n === d) score = 3;
      else if ((n.length >= 2 && d.includes(n)) || (d.length >= 2 && n.includes(d))) score = 2;
      else {
        const cTokens = c.name.normalize("NFKC").toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
        if (cTokens.some((t) => dTokens.includes(t))) score = 1;
      }
      return { userId: c.id, name: c.name, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ja"));
  return scored.slice(0, 3).map(({ userId, name }) => ({ userId, name }));
}

/** Effective record for one member in one occurrence (null = no signal at all = 欠席). */
export function effectiveRecord(
  userId: string,
  signals: { manual: AttendanceRow | null; join: AttendanceRow | null; meet: meeting.MeetPresence | null },
  thresholdSeconds: number,
): meeting.AttendanceRecord | null {
  const { manual, join, meet } = signals;
  const joinedAt = join?.joinedAt ?? null;
  if (manual) {
    return { userId, status: manual.status, source: "manual", joinedAt, meet, recordedBy: manual.recordedBy, updatedAt: manual.updatedAt };
  }
  if (meet) {
    return { userId, status: meet.durationSeconds >= thresholdSeconds ? "present" : "absent", source: "meet_api", joinedAt, meet, recordedBy: null, updatedAt: null };
  }
  if (join) return { userId, status: "present", source: "join", joinedAt, meet: null, recordedBy: null, updatedAt: join.updatedAt };
  return null;
}

/** Several matched participant rows of one member merged into one presence. */
function presenceOf(rows: readonly ParticipantRow[]): meeting.MeetPresence | null {
  if (rows.length === 0) return null;
  const first = rows.map((r) => r.firstJoin).sort()[0]!;
  const last = rows.some((r) => r.lastLeave === null) ? null : rows.map((r) => r.lastLeave!).sort().at(-1)!;
  return {
    firstJoin: first,
    lastLeave: last,
    durationSeconds: rows.reduce((s, r) => s + r.durationSeconds, 0),
    approx: rows.some((r) => r.approx),
  };
}

export function createAttendanceService(deps: AttendanceDeps): AttendanceService {
  const { orgId } = deps;

  /** The union of the meeting's targets (全体 / roles / members). */
  const expectedOf = (users: ActiveUser[], m: MeetingRow) => users.filter((u) => meeting.isInMeetingTargets(u, m.targets));

  /** Role names, best-effort (needs identity:read of the caller; a failure just shows a placeholder). */
  async function names(): Promise<Map<string, string>> {
    try {
      return new Map((await deps.roster.listRoles()).map((r) => [r.id, r.name]));
    } catch {
      return new Map();
    }
  }
  const targetName = (m: MeetingRow, n: Map<string, string>, users: readonly ActiveUser[] = []) =>
    targetsLabel(describeTargets(m.targets, n, new Map(users.map((u) => [u.id, u.name]))));

  async function regularMeetings(): Promise<MeetingRow[]> {
    const ids = await deps.store.listRegularIds(orgId);
    if (ids.size === 0) return [];
    return (await deps.meetings.listMeetings(orgId)).filter((m) => ids.has(m.id));
  }

  async function minPercent(): Promise<number> {
    return (await deps.store.getMinPercent(orgId)) ?? meeting.DEFAULT_MIN_ATTEND_PERCENT;
  }

  async function meetState(): Promise<meeting.MeetApiState> {
    const [access, lastRunAt] = await Promise.all([deps.meetRecords().catch(() => null), deps.store.lastIngestAt(orgId)]);
    return { ready: access?.ready ?? false, lastRunAt };
  }

  return {
    async join(userId, meetingId) {
      const m = await deps.meetings.getMeeting(orgId, meetingId);
      if (!m) throw errors.notFound("meeting", meetingId);
      // Instance check (the route is AUTHENTICATED): only the meeting's own members may join through Dub.
      const lone = m.targets.length === 1 && m.targets[0]!.kind === "role" ? m.targets[0]!.id : undefined;
      const users = expectedOf(await deps.roster.listActiveUsers(lone), m);
      if (!users.some((u) => u.id === userId)) throw errors.forbidden("この定例の対象メンバーではありません。");
      const regular = (await deps.store.listRegularIds(orgId)).has(m.id);
      const now = deps.now();
      const occ = regular ? openOccurrence(m, now) : null;
      if (!occ) return { meetUrl: m.meetUrl, recordedFor: null };
      if (!(await deps.store.getRecord(m.id, occ.date, userId, "join"))) {
        await deps.store.upsertRecord({
          meetingId: m.id,
          occurrenceDate: occ.date,
          userId,
          orgId,
          status: "present",
          source: "join",
          joinedAt: now,
          recordedBy: userId,
          updatedAt: now,
        });
      }
      return { meetUrl: m.meetUrl, recordedFor: occ.date };
    },

    async myRegulars(userId) {
      const linked = (await deps.store.listLinks(orgId)).some((l) => l.userId === userId);
      const rows = await regularMeetings();
      if (rows.length === 0) return { items: [], googleLinked: linked };
      const users = await deps.roster.listActiveUsers();
      const me = users.find((u) => u.id === userId);
      if (!me) return { items: [], googleLinked: linked };
      const mine = rows.filter((m) => meeting.isInMeetingTargets(me, m.targets));
      const n = mine.some((m) => m.targets.some((t) => t.kind === "role")) ? await names() : new Map<string, string>();
      const now = deps.now();
      const today = jstDate(now);
      const items: meeting.MyRegularMeeting[] = [];
      for (const m of mine) {
        const open = openOccurrence(m, now);
        const next =
          open ?? meeting.occurrenceStarts(m, today, addDays(today, NEXT_LOOKAHEAD_DAYS)).find((o) => Date.parse(o.startsAt) > Date.parse(now)) ?? null;
        const joined = open ? await deps.store.getRecord(m.id, open.date, userId, "join") : null;
        items.push({
          id: m.id,
          title: m.title,
          targetName: targetName(m, n, users),
          kind: meeting.regularKindOf(m.targetId),
          meetUrl: m.meetUrl,
          next,
          durationMinutes: m.durationMinutes,
          joinOpen: !!open,
          attended: !!joined,
        });
      }
      // Open now first, then soonest; ended series last.
      items.sort((a, b) => Number(b.joinOpen) - Number(a.joinOpen) || (a.next?.startsAt ?? "~").localeCompare(b.next?.startsAt ?? "~"));
      return { items, googleLinked: linked };
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
      const [percent, meetApi] = await Promise.all([minPercent(), meetState()]);
      const settings = { minPercent: percent };
      const rows = await regularMeetings();
      if (rows.length === 0) return { from, to, settings, meetApi, meetings: [], members: [] };
      const [users, n, records, participants, ingests, links] = await Promise.all([
        deps.roster.listActiveUsers(),
        names(),
        deps.store.listRecords(orgId, from, to),
        deps.store.listParticipants(orgId, from, to),
        deps.store.listIngests(orgId, from, to),
        deps.store.listLinks(orgId),
      ]);
      const linkOf = new Map(links.map((l) => [l.googleUserId, l.userId]));
      const group = <T extends { meetingId: string; occurrenceDate: string }>(list: readonly T[]) => {
        const out = new Map<string, T[]>();
        for (const r of list) {
          const k = `${r.meetingId}|${r.occurrenceDate}`;
          out.set(k, [...(out.get(k) ?? []), r]);
        }
        return out;
      };
      const recBy = group(records);
      const partBy = group(participants);
      const ingestBy = new Map(ingests.map((i) => [`${i.meetingId}|${i.occurrenceDate}`, i]));
      const tally = new Map<string, { expected: number; present: number; excused: number }>();
      const nowMs = Date.parse(now);

      const meetings: meeting.AttendanceMeeting[] = rows.map((m) => {
        const expected = expectedOf(users, m);
        const expectedIds = new Set(expected.map((u) => u.id));
        const threshold = Math.ceil((m.durationMinutes * 60 * percent) / 100);
        const occurrences: meeting.AttendanceOccurrence[] = meeting
          .occurrenceStarts(m, from, to)
          .filter((o) => Date.parse(o.startsAt) <= nowMs)
          .reverse()
          .map((o) => {
            const k = `${m.id}|${o.date}`;
            const parts = (partBy.get(k) ?? []).map((p) => ({ ...p, userId: p.googleUserId ? linkOf.get(p.googleUserId) ?? null : null }));
            const matchedIds = new Set(parts.map((p) => p.userId).filter((x): x is string => !!x));
            const unmatchedCandidates = expected.filter((u) => !matchedIds.has(u.id)).map((u) => ({ id: u.id, name: u.name }));
            const recs = recBy.get(k) ?? [];
            const userIds = new Set([...recs.map((r) => r.userId), ...matchedIds]);
            const records: meeting.AttendanceRecord[] = [];
            for (const userId of userIds) {
              const rec = effectiveRecord(
                userId,
                {
                  manual: recs.find((r) => r.userId === userId && r.source === "manual") ?? null,
                  join: recs.find((r) => r.userId === userId && r.source === "join") ?? null,
                  meet: presenceOf(parts.filter((p) => p.userId === userId)),
                },
                threshold,
              );
              if (rec) records.push(rec);
            }
            const ing = ingestBy.get(k);
            return {
              ...o,
              records,
              participants: parts
                .sort((a, b) => a.firstJoin.localeCompare(b.firstJoin))
                .map((p) => ({
                  key: p.participantKey,
                  kind: p.kind,
                  displayName: p.displayName,
                  googleUserId: p.googleUserId,
                  userId: p.userId,
                  firstJoin: p.firstJoin,
                  lastLeave: p.lastLeave,
                  durationSeconds: p.durationSeconds,
                  approx: p.approx,
                  suggestions: !p.userId && p.kind === "signed_in" ? suggestMembers(p.displayName, unmatchedCandidates) : [],
                })),
              ingest: ing ? { status: ing.status, ingestedAt: ing.ingestedAt, error: ing.lastError } : null,
            };
          });
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
            else if (r.status === "excused") t.excused++;
          }
        }
        return {
          id: m.id,
          title: m.title,
          targetId: m.targetId,
          targetName: targetName(m, n, users),
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
      return { from, to, settings, meetApi, meetings, members };
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
      if (status === null) {
        await deps.store.removeRecord(m.id, date, userId, "manual");
        return { record: null };
      }
      const users = expectedOf(await deps.roster.listActiveUsers(), m);
      if (!users.some((u) => u.id === userId)) {
        throw errors.validationFailed([{ field: "userId", reason: "not_expected" }], "この定例の対象メンバーではありません。");
      }
      const row: AttendanceRow = {
        meetingId: m.id,
        occurrenceDate: date,
        userId,
        orgId,
        status,
        source: "manual",
        joinedAt: null,
        recordedBy: by,
        updatedAt: deps.now(),
      };
      await deps.store.upsertRecord(row);
      const join = await deps.store.getRecord(m.id, date, userId, "join");
      return { record: effectiveRecord(userId, { manual: row, join, meet: null }, 0) };
    },

    async confirm(by, googleUserId, body) {
      const userId = body && typeof body === "object" ? (body as { userId?: unknown }).userId : undefined;
      if (typeof userId !== "string" || !userId) throw errors.validationFailed([{ field: "userId", reason: "required" }], "メンバーを選んでください。");
      if (!/^[\w-]{1,64}$/.test(googleUserId)) throw errors.validationFailed([{ field: "googleUserId", reason: "invalid" }]);
      if (!(await deps.roster.listActiveUsers()).some((u) => u.id === userId)) {
        throw errors.validationFailed([{ field: "userId", reason: "unknown" }], "そのメンバーが見つかりません。");
      }
      await deps.store.putLink({ orgId, googleUserId, userId, source: "confirmed", linkedBy: by, linkedAt: deps.now() });
      return { ok: true };
    },

    async unlink(googleUserId) {
      await deps.store.removeLink(orgId, googleUserId);
      return { ok: true };
    },

    async updateSettings(by, body) {
      const v = body && typeof body === "object" ? (body as { minPercent?: unknown }).minPercent : undefined;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 100) {
        throw errors.validationFailed([{ field: "minPercent", reason: "out_of_range" }], "出席とみなす割合は 1〜100% の整数で指定してください。");
      }
      await deps.store.setMinPercent(orgId, v, by, deps.now());
      return { minPercent: v };
    },

    async ingest(body) {
      const b = (body && typeof body === "object" ? body : {}) as meeting.IngestAttendanceRequest;
      if ((b.from !== undefined && !isDate(b.from)) || (b.to !== undefined && !isDate(b.to))) {
        throw errors.validationFailed([{ field: "from", reason: "invalid" }], "期間の形式が正しくありません（YYYY-MM-DD）。");
      }
      const access = await deps.meetRecords();
      if (!access) return { occurrences: 0, participants: 0, complete: true, skipped: "no_account" };
      if (!access.ready) return { occurrences: 0, participants: 0, complete: true, skipped: "scope_missing" };
      const r = await runMeetIngest(
        { meetings: deps.meetings, store: deps.store, client: access.client, orgId, now: deps.now },
        // A plain run reads what is pending (new / settling / failed occurrences); naming a range re-reads it.
        { force: !!(b.from || b.to), ...(b.from ? { from: b.from } : {}), ...(b.to ? { to: b.to } : {}), budget: MANUAL_INGEST_BUDGET, deadline: Date.now() + MANUAL_INGEST_TIME_MS },
      );
      if (!r.complete) await deps.kick?.(60_000).catch(() => undefined);
      return { ...r, skipped: null };
    },
  };
}

