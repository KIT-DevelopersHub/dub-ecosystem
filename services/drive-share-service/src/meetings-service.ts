// カレンダー > ミーティング. Meetings are events on the shared Google account connected in Drive共有 >
// 設定. Each target (a role, or "all" = every active member) owns ONE secondary calendar on that
// account (created lazily, named after the role / 全体); every meeting is an event on its target's
// calendar with a Meet link and the target's members as attendees. Every target calendar is shared
// read-only with every active member so anyone can show it in their own Google Calendar.
//
// Invite address per member: 名簿 Gmail if present, else the Dub login address.
// Reconcile (POST /meetings/sync and the hourly MeetingSyncDO alarm) keeps attendees and calendar
// shares in step with role membership, removing ONLY what we added (the invite / ACL ledgers) —
// never a guest or share someone added by hand in Google Calendar.
//
// Workers allow few subrequests per invocation, so Google calls run against a budget: a run that
// hits it stops cleanly and reports `complete: false`; the alarm picks up the rest a minute later.
//
// Writes answer as soon as the event and the D1 row exist: sharing the target calendar costs one
// Google call per member and blew the gateway's 15 s limit (504 although the meeting was made), so
// it is left to the sync the write kicks (MeetingSyncDO, no request deadline).
//
// Google Calendar is the source of truth for an event: create writes the D1 row FIRST (syncedAt
// null) and inserts the event under an id derived from the meeting id, so a request cut off midway
// never leaves an event Dub does not know (the sync finishes it). Reconcile mirrors Google back:
// an event deleted there removes the meeting, an edit there (title / time / repeat) updates it.
//
// Every Meet is opened to anyone with the link (Meet REST, best-effort): right after the event is
// made, and by the sync for meetings made before that or while the Meet scope was missing.
//
// A Google Calendar usage limit ends the run on the spot and pauses the sync for QUOTA_PAUSE_MS
// (state in MeetingSyncDO): while paused it makes no Calendar call, from the alarm or by hand. Only
// Calendar counts: Meet REST (openMeet, the ingest) and Drive have quotas of their own, keep
// running, and a limit on them pauses nothing.
import { errors } from "@dub/errors";
import { meeting } from "@dub/types";
import { EventIdTaken, type CalendarAttendee, type CalendarClient, type CalendarEvent, type CalendarEventInput } from "./google/calendar-client";
import { GoogleQuotaError, isCalendarQuota } from "./drive-client";
import type { AttendanceStore } from "./attendance-store";
import type { MemberDirectory } from "./member-directory";
import type { MeetingRow, MeetingStore } from "./meetings-store";
import { DESCRIPTION_MAX, DURATION_MAX, DURATION_MIN, endsAt, fromRecurrence, TITLE_MAX, toRecurrence, validateMeeting, type MeetingFields } from "./meeting-rules";
import { createInMemorySyncState, type MeetingSyncState } from "./meeting-sync-state";
import type { RoleMembership } from "./role-membership";

export const ALL_TARGET_NAME = "全体";
const SOON_MS = 60_000;
const SYNC_TIME_LIMIT_MS = 8_000;
/** A list pulls the sync this close, so edits made in Google Calendar show up quickly… */
const LIST_SOON_MS = 15_000;
/** …unless a sync ran this recently (open tabs must not keep Google busy). */
const LIST_KICK_MIN_GAP_MS = 60_000;
/** How long the sync leaves Google Calendar alone after a usage limit. */
export const QUOTA_PAUSE_MS = 6 * 60 * 60 * 1000;
const NO_CALENDAR_SCOPE =
  "Google アカウントにカレンダーの権限がありません。Drive共有 > 設定 で同じアカウントを「再接続」してください。";

/** The Google account meetings are created as, resolved per request. */
export interface MeetingAccount {
  /** driveshare_google_accounts row id, "secret" (refresh-token secret) or "mock". */
  accountId: string;
  email: string | null;
  /** false = the token lacks the calendar scope (or the account is unusable): reconnect. */
  calendarReady: boolean;
  /** false = the token lacks the Meet settings scope: Meet links stay as Google made them. */
  meetReady: boolean;
  calendar: CalendarClient;
}

export interface MeetingsDeps {
  store: MeetingStore;
  /** Which meetings are 定例 (trackAttendance). */
  attendance: AttendanceStore;
  roster: RoleMembership;
  directory: MemberDirectory;
  account: () => Promise<MeetingAccount>;
  orgId: string;
  now: () => string;
  newId: () => string;
  /** Ensure the sync alarm is scheduled; `soonMs` pulls it earlier (best-effort). */
  kick?: (soonMs?: number) => Promise<void>;
  /** Max Google calls per invocation (default 25). */
  googleBudget?: number;
  /** Wall-clock cap of one sync run (default 8 s, under the gateway's 15 s). */
  syncTimeLimitMs?: number;
  /** Meet links already confirmed open (shared per isolate so the sync checks each once). */
  openedMeets?: Set<string>;
  /** Keeps work alive after the response (waitUntil). Absent = run it inline. */
  background?: (work: Promise<unknown>) => void;
  /** The quota pause (MeetingSyncDO). Absent = per isolate. */
  syncState?: MeetingSyncState;
}

export interface SyncResult extends meeting.SyncMeetingsResponse {
  /** false = stopped at the Google call budget; run again to finish. */
  complete: boolean;
  /** Set when the sync is paused by a Calendar usage limit (epoch ms it ends). Not a reason to
   *  run again: the run is over, and the next one is the hourly alarm. */
  quotaPausedUntil?: number;
}

export interface MeetingsService {
  list(): Promise<meeting.ListMeetingsResponse>;
  targets(userId: string | undefined): Promise<meeting.ListMeetingTargetsResponse>;
  create(userId: string, body: unknown): Promise<meeting.Meeting>;
  update(id: string, body: unknown, userId?: string): Promise<meeting.Meeting>;
  remove(id: string): Promise<void>;
  /** opts.system = the alarm: a not-ready account is skipped instead of a 409. */
  sync(opts?: { system?: boolean }): Promise<SyncResult>;
}

/** One member to invite. */
interface Invitee {
  userId: string;
  /** Invite address, lowercased (名簿 Gmail, else Dub address). */
  email: string;
  name: string;
  roleIds: string[];
  hasGoogle: boolean;
}

class BudgetExhausted extends Error {
  constructor() {
    super("google call budget exhausted");
    this.name = "BudgetExhausted";
  }
}

/** Wrap a client so it refuses calls once `limit` is spent or past `deadline` (epoch ms). */
function budgeted(client: CalendarClient, limit: number, deadline = Infinity): CalendarClient & { exhausted: () => boolean } {
  let left = limit;
  let hit = false;
  const spend = () => {
    if (left <= 0 || Date.now() > deadline) {
      hit = true;
      throw new BudgetExhausted();
    }
    left--;
  };
  return {
    exhausted: () => hit,
    createCalendar: async (s, tz) => (spend(), client.createCalendar(s, tz)),
    listAcl: async (c) => (spend(), client.listAcl(c)),
    insertAcl: async (c, e) => (spend(), client.insertAcl(c, e)),
    deleteAcl: async (c, r) => (spend(), client.deleteAcl(c, r)),
    insertEvent: async (c, i) => (spend(), client.insertEvent(c, i)),
    getEvent: async (c, e) => (spend(), client.getEvent(c, e)),
    patchEvent: async (c, e, p) => (spend(), client.patchEvent(c, e, p)),
    deleteEvent: async (c, e) => (spend(), client.deleteEvent(c, e)),
    // Up to two calls (look the space up, then patch it).
    openMeet: async (u) => (spend(), spend(), client.openMeet(u)),
  };
}

const lower = (e: string) => e.trim().toLowerCase();

/** The Google event id of a meeting: base32hex ("a"–"v", digits) as Google requires, unique per meeting. */
export function eventIdFor(meetingId: string): string {
  return `dub${[...new TextEncoder().encode(meetingId)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The meeting fields as Google holds them now (null = nothing to take over). */
function fieldsFromEvent(m: MeetingRow, ev: CalendarEvent): Partial<MeetingFields> | null {
  const startMs = ev.start ? Date.parse(ev.start) : NaN;
  const endMs = ev.end ? Date.parse(ev.end) : NaN;
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || ev.summary === undefined) return null;
  const startsAt = new Date(startMs).toISOString();
  const out: Partial<MeetingFields> = {};
  const title = ev.summary.trim();
  if (title && title.length <= TITLE_MAX && title !== m.title) out.title = title;
  // Google Calendar's editor stores HTML; Dub shows and writes back plain text, so leave such a description alone.
  const d = ev.description;
  if (d !== undefined && d !== m.description && !/<[a-z/][^>]*>/i.test(d ?? "") && (d?.length ?? 0) <= DESCRIPTION_MAX) out.description = d;
  if (startsAt !== m.startsAt) out.startsAt = startsAt;
  const minutes = Math.round((endMs - startMs) / 60_000);
  if (minutes >= DURATION_MIN && minutes <= DURATION_MAX && minutes !== m.durationMinutes) out.durationMinutes = minutes;
  const rule = ev.recurrence ? fromRecurrence(ev.recurrence) : null;
  if (rule && (rule.recurrence !== m.recurrence || rule.until !== m.until)) Object.assign(out, rule);
  return Object.keys(out).length > 0 ? out : null;
}

function log(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ service: "drive-share-service", event, ...fields }));
}

function fieldsOf(m: MeetingRow): MeetingFields {
  return {
    title: m.title,
    description: m.description,
    targetId: m.targetId,
    startsAt: m.startsAt,
    durationMinutes: m.durationMinutes,
    recurrence: m.recurrence,
    until: m.until,
  };
}

function eventInput(f: MeetingFields): Omit<CalendarEventInput, "attendees"> {
  return {
    summary: f.title,
    description: f.description,
    start: f.startsAt,
    end: endsAt(f),
    timeZone: meeting.MEETING_TIME_ZONE,
    recurrence: toRecurrence(f),
  };
}

/** The optional trackAttendance flag of a create / update body (undefined = leave as is). */
function trackAttendanceOf(body: unknown): boolean | undefined {
  if (!body || typeof body !== "object" || !("trackAttendance" in body)) return undefined;
  const v = (body as { trackAttendance?: unknown }).trackAttendance;
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw errors.validationFailed([{ field: "trackAttendance", reason: "invalid" }], "「定例として出席を取る」の指定が正しくありません。");
  return v;
}

function toMeeting(m: MeetingRow, targetName: string, attendeeCount: number, trackAttendance: boolean): meeting.Meeting {
  return {
    id: m.id,
    title: m.title,
    description: m.description,
    targetId: m.targetId,
    targetName,
    startsAt: m.startsAt,
    durationMinutes: m.durationMinutes,
    recurrence: m.recurrence,
    until: m.until,
    meetUrl: m.meetUrl,
    htmlLink: m.htmlLink,
    attendeeCount,
    trackAttendance,
    createdBy: m.createdBy,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

export function createMeetingsService(deps: MeetingsDeps): MeetingsService {
  const { store, orgId } = deps;
  const budgetLimit = deps.googleBudget ?? 25;
  const syncTimeLimit = deps.syncTimeLimitMs ?? SYNC_TIME_LIMIT_MS;
  const openedMeets = deps.openedMeets ?? new Set<string>();
  const syncState = deps.syncState ?? createInMemorySyncState();

  /** Start the pause. Never throws: the limit itself is what the caller must report. */
  async function pauseSync(err: GoogleQuotaError): Promise<number | null> {
    try {
      const now = Date.parse(deps.now());
      const { until, started } = await syncState.pause(now, now + QUOTA_PAUSE_MS);
      if (started) log("meeting_sync_quota_paused", { pausedUntil: new Date(until).toISOString(), reason: err.reason, operation: err.operation, googleMessage: err.googleMessage });
      return until;
    } catch (cause) {
      log("meeting_sync_quota_pause_failed", { message: cause instanceof Error ? cause.message : String(cause) });
      return null;
    }
  }

  /** A write that hits the limit tells the sync too: it would only hit the same limit. */
  async function pausingOnQuota<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (isCalendarQuota(err)) await pauseSync(err);
      throw err;
    }
  }

  /** After a write: run the sync within a minute (shares the calendar, follows membership). */
  async function kick(soonMs: number | undefined): Promise<void> {
    try {
      await deps.kick?.(soonMs);
    } catch (err) {
      log("meeting_sync_kick_failed", { message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function readyAccount(): Promise<MeetingAccount> {
    const account = await deps.account();
    if (!account.calendarReady) throw errors.conflict(NO_CALENDAR_SCOPE, { reason: "calendar_scope_missing" });
    return account;
  }

  /** Let anyone with the link join. Best-effort: a Meet that stays restricted never fails the meeting. */
  async function openMeet(cal: CalendarClient, account: MeetingAccount, meetUrl: string | null): Promise<void> {
    if (!account.meetReady || !meetUrl || openedMeets.has(meetUrl)) return;
    try {
      if (await cal.openMeet(meetUrl)) openedMeets.add(meetUrl);
    } catch (err) {
      if (err instanceof BudgetExhausted) throw err;
      log("meeting_meet_open_failed", { message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Role id -> name (identity:read of the acting user). */
  async function roleNames(): Promise<Map<string, string>> {
    return new Map((await deps.roster.listRoles()).map((r) => [r.id, r.name]));
  }

  async function targetName(targetId: string, names?: Map<string, string>): Promise<string | null> {
    if (targetId === meeting.ALL_MEMBERS_TARGET_ID) return ALL_TARGET_NAME;
    return (names ?? (await roleNames())).get(targetId) ?? null;
  }

  async function requireTargetName(targetId: string): Promise<string> {
    const name = await targetName(targetId);
    if (!name) throw errors.validationFailed([{ field: "targetId", reason: "unknown_role" }], "対象のロールが見つかりません。");
    return name;
  }

  /** Active members with their invite address (one identity listing + one 名簿 lookup). identity
   *  reads roles per listed user, so narrow to `roleId` whenever only one target is wanted. */
  async function invitees(roleId?: string): Promise<Invitee[]> {
    const users = await deps.roster.listActiveUsers(roleId);
    const google = await deps.directory.googleEmails(users.map((u) => u.id));
    return users.map((u) => {
      const g = google.get(u.id);
      return { userId: u.id, email: lower(g?.gmail ?? u.email), name: u.name, roleIds: u.roleIds, hasGoogle: !!g?.gmail };
    });
  }

  /** One invite per address. After the target filter: two accounts can share a Gmail, and the
   *  one kept must belong to the target, or the sync would uninvite the address. */
  const uniqueEmails = (list: Invitee[]) => [...new Map([...list].reverse().map((i) => [i.email, i])).values()].reverse();

  const forTarget = (all: Invitee[], targetId: string) =>
    uniqueEmails(targetId === meeting.ALL_MEMBERS_TARGET_ID ? all : all.filter((i) => i.roleIds.includes(targetId)));

  const inviteesOf = async (targetId: string) =>
    forTarget(await invitees(targetId === meeting.ALL_MEMBERS_TARGET_ID ? undefined : targetId), targetId);

  /** Open the Meet without holding the response; the sync retries one that did not get through. */
  async function openMeetAfterResponse(account: MeetingAccount, meetUrl: string | null): Promise<void> {
    const work = openMeet(account.calendar, account, meetUrl);
    if (deps.background) deps.background(work);
    else await work;
  }

  /** The target's calendar on this account, created on first use. */
  async function ensureCalendar(cal: CalendarClient, accountId: string, targetId: string, name: string): Promise<string> {
    const existing = await store.getCalendar(orgId, targetId, accountId);
    if (existing) return existing.calendarId;
    const created = await cal.createCalendar(name, meeting.MEETING_TIME_ZONE);
    const row = await store.insertCalendar({ orgId, targetId, accountId, calendarId: created.id, createdAt: deps.now() });
    return row.calendarId;
  }

  /** Share one calendar read-only with exactly `desired` (plus whatever was shared by hand). */
  async function reconcileAcl(cal: CalendarClient, calendarId: string, desired: Set<string>, ownerEmail: string | null): Promise<void> {
    const rules = await cal.listAcl(calendarId);
    const shared = new Set(rules.map((r) => r.email).filter((e): e is string => !!e));
    const ledger = await store.listAcl(orgId, calendarId);
    // One address Google refuses (e.g. it cannot take a share) must not block the others.
    const each = async (email: string, op: () => Promise<void>) => {
      try {
        await op();
      } catch (err) {
        if (err instanceof BudgetExhausted || isCalendarQuota(err)) throw err;
        log("meeting_calendar_acl_failed", { calendarId, email, message: err instanceof Error ? err.message : String(err) });
      }
    };
    for (const email of desired) {
      if (shared.has(email) || email === ownerEmail) continue;
      await each(email, async () => {
        const rule = await cal.insertAcl(calendarId, email);
        await store.putAcl({ orgId, calendarId, email, ruleId: rule.id });
      });
    }
    for (const row of ledger) {
      if (desired.has(row.email)) continue;
      await each(row.email, async () => {
        await cal.deleteAcl(calendarId, row.ruleId);
        await store.removeAcl(orgId, calendarId, row.email);
      });
    }
  }

  /** Mirror Google's state of one meeting into D1, then bring its attendees in line with its target. */
  async function reconcileMeeting(
    cal: CalendarClient,
    row: MeetingRow,
    desired: Invitee[],
  ): Promise<{ added: number; removed: number }> {
    let m = row;
    let ev = await cal.getEvent(m.calendarId, m.googleEventId);
    if (!ev && m.syncedAt === null) {
      // The create was cut off before its event existed: finish it. A taken id = it was created and
      // already deleted in Google Calendar (falls through to the removal below).
      try {
        ev = await cal.insertEvent(m.calendarId, { ...eventInput(fieldsOf(m)), id: m.googleEventId, attendees: desired.map((d) => ({ email: d.email })) });
        await store.replaceInvites(m.id, desired.map((d) => ({ meetingId: m.id, email: d.email, userId: d.userId })));
        log("meeting_sync_create_finished", { meetingId: m.id });
      } catch (err) {
        if (!(err instanceof EventIdTaken)) throw err;
      }
    }
    if (!ev) {
      // Deleted in Google Calendar: Dub follows. Only when the calendar itself still answers — a lost
      // grant or a switched account reads as "gone" too and must never wipe meetings (throws here) —
      // and only if the row still points at that event (a target move meanwhile made a new one).
      await cal.listAcl(m.calendarId);
      if (await store.deleteMeetingIf(m.id, m.calendarId, m.googleEventId)) log("meeting_sync_event_gone_removed", { meetingId: m.id });
      return { added: 0, removed: 0 };
    }
    const pulled = fieldsFromEvent(m, ev);
    if (pulled) {
      m = { ...m, ...pulled, updatedAt: deps.now() };
      log("meeting_sync_pulled_from_google", { meetingId: m.id, fields: Object.keys(pulled) });
    }

    const ledger = await store.listInvites(m.id);
    // An empty target with invites on record is far more likely a transient identity glitch than
    // a role emptied on purpose — never mass-uninvite on it.
    if (desired.length === 0 && ledger.length > 0) {
      log("meeting_sync_empty_target_skipped", { meetingId: m.id, targetId: m.targetId });
      await store.updateMeetingIf({ ...m, syncedAt: deps.now() }, row.updatedAt);
      return { added: 0, removed: 0 };
    }
    const want = new Map(desired.map((d) => [d.email, d]));
    const removeSet = new Set(ledger.filter((r) => !want.has(r.email)).map((r) => r.email));
    const current = new Set(ev.attendees.map((a) => lower(a.email)));
    const kept: CalendarAttendee[] = ev.attendees.filter((a) => !removeSet.has(lower(a.email)));
    const toAdd = desired.filter((d) => !current.has(d.email));
    const removedFromEvent = ev.attendees.length - kept.length;

    let next = m;
    if (toAdd.length > 0 || removedFromEvent > 0) {
      const patched = await cal.patchEvent(m.calendarId, m.googleEventId, {
        attendees: [...kept, ...toAdd.map((d) => ({ email: d.email }))],
      });
      next = { ...m, meetUrl: patched.meetUrl ?? m.meetUrl, htmlLink: patched.htmlLink ?? m.htmlLink };
    } else if (!m.meetUrl || !m.htmlLink) {
      next = { ...m, meetUrl: m.meetUrl ?? ev.meetUrl, htmlLink: m.htmlLink ?? ev.htmlLink };
    }

    const ledgerEmails = new Set(ledger.map((r) => r.email));
    const nextLedger = [
      ...ledger.filter((r) => !removeSet.has(r.email)),
      ...toAdd.filter((d) => !ledgerEmails.has(d.email)).map((d) => ({ meetingId: m.id, email: d.email, userId: d.userId })),
    ];
    if (removeSet.size > 0 || nextLedger.length !== ledger.length) await store.replaceInvites(m.id, nextLedger);
    if (!(await store.updateMeetingIf({ ...next, syncedAt: deps.now() }, row.updatedAt))) {
      log("meeting_sync_row_changed_skipped", { meetingId: m.id }); // edited meanwhile: the next run catches up
    }
    return { added: toAdd.length, removed: removedFromEvent };
  }

  /** The Meet step of the sync (Meet REST, not Calendar: it also runs during a pause). */
  async function openMeets(cal: CalendarClient, account: MeetingAccount): Promise<void> {
    // Re-read: reconcile may have just filled in a Meet link.
    try {
      for (const m of await store.listMeetings(orgId)) {
        if (m.accountId === account.accountId) await openMeet(cal, account, m.meetUrl);
      }
    } catch (err) {
      if (!(err instanceof BudgetExhausted)) throw err;
    }
  }

  const service: MeetingsService = {
    async list() {
      const [rows, counts, regulars] = await Promise.all([store.listMeetings(orgId), store.inviteCounts(orgId), deps.attendance.listRegularIds(orgId)]);
      const lastSync = Math.max(0, ...rows.map((r) => (r.syncedAt ? Date.parse(r.syncedAt) : 0)));
      if (rows.length > 0 && Date.parse(deps.now()) - lastSync > LIST_KICK_MIN_GAP_MS) await kick(LIST_SOON_MS);
      let names = new Map<string, string>();
      if (rows.some((r) => r.targetId !== meeting.ALL_MEMBERS_TARGET_ID)) {
        try {
          names = await roleNames();
        } catch (err) {
          log("meeting_role_names_failed", { message: err instanceof Error ? err.message : String(err) });
        }
      }
      let account: meeting.MeetingAccountState = { email: null, calendarReady: false };
      try {
        const a = await deps.account();
        account = { email: a.email, calendarReady: a.calendarReady };
      } catch (err) {
        log("meeting_account_state_failed", { message: err instanceof Error ? err.message : String(err) });
      }
      return {
        items: rows.map((r) =>
          toMeeting(r, r.targetId === meeting.ALL_MEMBERS_TARGET_ID ? ALL_TARGET_NAME : names.get(r.targetId) ?? "（削除されたロール）", counts.get(r.id) ?? 0, regulars.has(r.id)),
        ),
        account,
      };
    },

    async targets(userId) {
      const [roles, users] = await Promise.all([deps.roster.listRoles(), deps.roster.listActiveUsers()]);
      const me = users.find((u) => u.id === userId);
      const items: meeting.MeetingTarget[] = [
        { id: meeting.ALL_MEMBERS_TARGET_ID, name: ALL_TARGET_NAME, memberCount: users.length, isMine: true },
        ...roles.map((r) => ({
          id: r.id,
          name: r.name,
          memberCount: users.filter((u) => u.roleIds.includes(r.id)).length,
          isMine: !!me?.roleIds.includes(r.id),
        })),
      ];
      return { items };
    },

    async create(userId, body) {
      const f = validateMeeting(body);
      const track = trackAttendanceOf(body) ?? false;
      const began = Date.now();
      const [name, account, members] = await Promise.all([requireTargetName(f.targetId), readyAccount(), inviteesOf(f.targetId)]);
      const cal = budgeted(account.calendar, budgetLimit);
      const preparedAt = Date.now();

      const calendarId = await ensureCalendar(cal, account.accountId, f.targetId, name);
      const calendarAt = Date.now();
      const at = deps.now();
      const id = deps.newId();
      const row: MeetingRow = {
        id,
        orgId,
        targetId: f.targetId,
        accountId: account.accountId,
        calendarId,
        googleEventId: eventIdFor(id),
        title: f.title,
        description: f.description,
        startsAt: f.startsAt,
        durationMinutes: f.durationMinutes,
        recurrence: f.recurrence,
        until: f.until,
        meetUrl: null,
        htmlLink: null,
        createdBy: userId,
        createdAt: at,
        updatedAt: at,
        // null until the event exists: a run cut off before that is finished by the sync.
        syncedAt: null,
      };
      await store.insertMeeting(row);
      let done: MeetingRow;
      let insertMs: number;
      try {
        await store.replaceInvites(row.id, members.map((m) => ({ meetingId: row.id, email: m.email, userId: m.userId })));
        await kick(SOON_MS);
        const insertAt = Date.now();
        const ev = await cal.insertEvent(calendarId, { ...eventInput(f), id: row.googleEventId, attendees: members.map((m) => ({ email: m.email })) });
        insertMs = Date.now() - insertAt;
        done = { ...row, meetUrl: ev.meetUrl, htmlLink: ev.htmlLink, syncedAt: deps.now() };
        await store.updateMeeting(done);
      } catch (err) {
        // Neither half may outlive a failed create. A refused insert left no event, and one more
        // call would only spend more of the limit.
        if (!isCalendarQuota(err)) await account.calendar.deleteEvent(calendarId, row.googleEventId).catch(() => undefined);
        await store.deleteMeeting(row.id).catch(() => undefined);
        throw err;
      }
      await openMeetAfterResponse(account, done.meetUrl);
      if (track) await deps.attendance.setRegular(orgId, done.id, true, userId, deps.now());
      log("meeting_create_timing", { meetingId: id, attendees: members.length, prepareMs: preparedAt - began, calendarMs: calendarAt - preparedAt, insertEventMs: insertMs, totalMs: Date.now() - began });
      return toMeeting(done, name, members.length, track);
    },

    async update(id, body, userId) {
      const row = await store.getMeeting(orgId, id);
      if (!row) throw errors.notFound("meeting", id);
      const f = validateMeeting(body, fieldsOf(row));
      const track = trackAttendanceOf(body);
      const name = await requireTargetName(f.targetId);
      const account = await readyAccount();
      if (account.accountId !== row.accountId) {
        throw errors.conflict("このミーティングは以前の Google アカウントで作成されています。削除して作り直してください。", { reason: "account_switched" });
      }
      const cal = budgeted(account.calendar, budgetLimit);
      const at = deps.now();
      let next: MeetingRow;
      let attendeeCount: number;

      if (f.targetId !== row.targetId) {
        // Moving target = a new event on the other calendar (new Meet link), then drop the old one.
        const members = await inviteesOf(f.targetId);
        const calendarId = await ensureCalendar(cal, account.accountId, f.targetId, name);
        const ev = await cal.insertEvent(calendarId, { ...eventInput(f), attendees: members.map((m) => ({ email: m.email })) });
        next = { ...row, ...f, calendarId, googleEventId: ev.id, meetUrl: ev.meetUrl, htmlLink: ev.htmlLink, updatedAt: at, syncedAt: at };
        await store.updateMeeting(next);
        await store.replaceInvites(row.id, members.map((m) => ({ meetingId: row.id, email: m.email, userId: m.userId })));
        await openMeetAfterResponse(account, next.meetUrl);
        try {
          await account.calendar.deleteEvent(row.calendarId, row.googleEventId);
        } catch (err) {
          if (isCalendarQuota(err)) await pauseSync(err);
          log("meeting_old_event_delete_failed", { meetingId: row.id, message: err instanceof Error ? err.message : String(err) });
        }
        attendeeCount = members.length;
      } else {
        // Only what changed: a time change must not write back a title or description edited in
        // Google Calendar that the sync has not pulled yet (or never will: HTML descriptions).
        const { summary, description, recurrence, ...when } = eventInput(f);
        const ev = await cal.patchEvent(row.calendarId, row.googleEventId, {
          ...when,
          ...(f.title !== row.title ? { summary } : {}),
          ...(f.description !== row.description ? { description } : {}),
          ...(f.recurrence !== row.recurrence || f.until !== row.until ? { recurrence } : {}),
        });
        next = { ...row, ...f, meetUrl: ev.meetUrl ?? row.meetUrl, htmlLink: ev.htmlLink ?? row.htmlLink, updatedAt: at };
        await store.updateMeeting(next);
        attendeeCount = (await store.listInvites(row.id)).length;
      }
      await kick(SOON_MS);
      if (track !== undefined) await deps.attendance.setRegular(orgId, row.id, track, userId ?? row.createdBy, deps.now());
      const regular = track ?? (await deps.attendance.listRegularIds(orgId)).has(row.id);
      return toMeeting(next, name, attendeeCount, regular);
    },

    async remove(id) {
      const row = await store.getMeeting(orgId, id);
      if (!row) throw errors.notFound("meeting", id);
      const account = await readyAccount();
      if (account.accountId === row.accountId) {
        await account.calendar.deleteEvent(row.calendarId, row.googleEventId);
      } else {
        log("meeting_delete_other_account", { meetingId: id, accountId: row.accountId });
      }
      await store.deleteMeeting(id);
    },

    async sync(opts) {
      const syncedAt = deps.now();
      const empty: SyncResult = { syncedAt, meetings: 0, invitedAdded: 0, invitedRemoved: 0, withoutGoogleAccount: [], complete: true };
      const account = await deps.account();
      if (!account.calendarReady) {
        if (opts?.system) {
          log("meeting_sync_skipped_not_ready", { accountId: account.accountId });
          return empty;
        }
        throw errors.conflict(NO_CALENDAR_SCOPE, { reason: "calendar_scope_missing" });
      }
      const cal = budgeted(account.calendar, budgetLimit, Date.now() + syncTimeLimit);
      const state = await syncState.load();
      if (state.pausedUntil !== null && state.pausedUntil > Date.parse(syncedAt)) {
        if (!opts?.system) throw new GoogleQuotaError("calendar", "sync_paused");
        if (account.meetReady) await openMeets(cal, account);
        return { ...empty, quotaPausedUntil: state.pausedUntil };
      }
      const all = await invitees();
      const out = { ...empty, withoutGoogleAccount: uniqueEmails(all).filter((i) => !i.hasGoogle).map((i) => ({ userId: i.userId, name: i.name, email: i.email })) };

      try {
        const rows = (await store.listMeetings(orgId)).filter((m) => m.accountId === account.accountId);
        for (const m of rows) {
          try {
            const r = await reconcileMeeting(cal, m, forTarget(all, m.targetId));
            out.meetings++;
            out.invitedAdded += r.added;
            out.invitedRemoved += r.removed;
          } catch (err) {
            if (err instanceof BudgetExhausted) break;
            if (isCalendarQuota(err)) throw err;
            log("meeting_sync_failed", { meetingId: m.id, message: err instanceof Error ? err.message : String(err) });
          }
        }

        if (!cal.exhausted()) {
          const desired = new Set(all.map((i) => i.email));
          const owner = account.email ? lower(account.email) : null;
          for (const c of await store.listCalendars(orgId, account.accountId)) {
            try {
              await reconcileAcl(cal, c.calendarId, desired, owner);
            } catch (err) {
              if (err instanceof BudgetExhausted) break;
              if (isCalendarQuota(err)) throw err;
              log("meeting_calendar_acl_sync_failed", { calendarId: c.calendarId, message: err instanceof Error ? err.message : String(err) });
            }
          }
        }
      } catch (err) {
        if (!isCalendarQuota(err)) throw err;
        const until = await pauseSync(err);
        if (!opts?.system) throw err;
        return { ...out, ...(until === null ? {} : { quotaPausedUntil: until }) };
      }

      if (!cal.exhausted() && account.meetReady) await openMeets(cal, account);
      out.complete = !cal.exhausted();
      // Keep the hourly loop alive; an unfinished run continues within a minute.
      if (!opts?.system) await kick(out.complete ? undefined : SOON_MS);
      return out;
    },
  };

  return {
    ...service,
    create: (userId, body) => pausingOnQuota(() => service.create(userId, body)),
    update: (id, body, userId) => pausingOnQuota(() => service.update(id, body, userId)),
    remove: (id) => pausingOnQuota(() => service.remove(id)),
  };
}
