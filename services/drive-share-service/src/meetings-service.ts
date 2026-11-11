// カレンダー > ミーティング. Meetings are events on the shared Google account connected in Drive共有 >
// 設定. Each target (a role, or "all" = every active member) owns ONE secondary calendar on that
// account (created lazily, named after the role / 全体); every meeting is an event on its target's
// calendar with a Meet link and the target's members as attendees. A target calendar is shared
// read-only with that target's members only (the 全体 one with every active member), so each member
// gets the "add this calendar" mail just for their own roles.
//
// Invite / share address per member: the 名簿 Gmail. A member without one (hasGoogle false) and the
// shared group / bot addresses (NON_PERSONAL_LOCAL_PARTS) are left out of both: they have no Google
// account, and mailing them only bounced.
// Reconcile (POST /meetings/sync and the hourly MeetingSyncDO alarm) keeps attendees and calendar
// shares in step with role membership, removing ONLY what we added (the invite / ACL ledgers) —
// never a guest or share someone added by hand in Google Calendar.
//
// Workers allow few subrequests per invocation, so Google calls run against a budget. Only the
// meeting scan can leave a run `complete: false`, and it continues where it stopped (meetingCursor),
// so a budget stop ends after one pass over the meetings instead of repeating the same ones.
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
// running, and a limit on them pauses nothing. A limit hit while sharing the calendars pauses only
// the shares (aclWritesNotBefore): attendees — the invites of members who just joined a role — keep
// their hourly turn. Sharing ~60 members on every target calendar is what keeps running into it.
//
// To stay under those limits the sync spends little: a calendar whose share list has not changed
// costs no listAcl (one full check a day still catches changes made in Google), a share that failed
// waits ACL_RETRY_WAIT_MS, share writes are paced (ACL_WRITES_PER_RUN every ACL_WRITE_INTERVAL_MS),
// and a meeting leaves the sync ENDED_SYNC_GRACE_MS after its last occurrence. Once a meeting is over
// its attendees are frozen: Google would mail every change (sendUpdates=all) about a past meeting.
import { errors } from "@dub/errors";
import { meeting } from "@dub/types";
import { EventIdTaken, type CalendarAttendee, type CalendarClient, type CalendarEvent, type CalendarEventInput } from "./google/calendar-client";
import { GoogleQuotaError, isCalendarQuota } from "./drive-client";
import type { AttendanceStore } from "./attendance-store";
import type { MemberDirectory } from "./member-directory";
import type { MeetingRow, MeetingStore } from "./meetings-store";
import { DESCRIPTION_MAX, DURATION_MAX, DURATION_MIN, endsAt, fromRecurrence, lastEndMs, TITLE_MAX, toRecurrence, validateMeeting, type MeetingFields } from "./meeting-rules";
import { createInMemorySyncState, type CalendarAclState, type MeetingSyncSnapshot, type MeetingSyncState } from "./meeting-sync-state";
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
/** A share Google refused (for any reason but a limit) is not retried sooner than this. */
export const ACL_RETRY_WAIT_MS = 24 * 60 * 60 * 1000;
/** A calendar is compared with Google this often even when its share list has not changed. */
export const ACL_FULL_CHECK_MS = 24 * 60 * 60 * 1000;
/** Share writes (add + remove, failed ones too) in one run… */
export const ACL_WRITES_PER_RUN = 10;
/** …and the wait before more. Google publishes no safe rate we could confirm, so this is cautious:
 *  at most 40 writes an hour, against 35 every 2 minutes (1,050 an hour) before. */
export const ACL_WRITE_INTERVAL_MS = 15 * 60 * 1000;
/** A meeting stays in the sync this long after it ended, so edits made in Google still arrive. */
export const ENDED_SYNC_GRACE_MS = 24 * 60 * 60 * 1000;
/** Org-domain mailboxes that are routing aliases / bots, not a person's Google account. */
const ORG_MAIL_DOMAIN = "developershub.jp";
const NON_PERSONAL_LOCAL_PARTS = new Set(["member", "maintainer", "commander-bot"]);
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
  /** Shares are left for a paced continuation, due in this many ms. The run still counts as
   *  complete: the wait is long, and the other phases must not sit behind it. */
  aclContinueMs?: number;
}

export interface MeetingsService {
  list(): Promise<meeting.ListMeetingsResponse>;
  targets(userId: string | undefined): Promise<meeting.ListMeetingTargetsResponse>;
  create(userId: string, body: unknown): Promise<meeting.Meeting>;
  update(id: string, body: unknown, userId?: string): Promise<meeting.Meeting>;
  remove(id: string): Promise<void>;
  /** Invitees and their answers in Google Calendar; `date` (JST) = one occurrence of a series. */
  attendees(id: string, date?: string): Promise<meeting.ListMeetingAttendeesResponse>;
  /** opts.system = the alarm: a not-ready account is skipped instead of a 409.
   *  opts.aclOnly = a paced continuation: only the calendar shares. */
  sync(opts?: { system?: boolean; aclOnly?: boolean }): Promise<SyncResult>;
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

const RESPONSE_ORDER: readonly meeting.MeetingResponseStatus[] = ["accepted", "tentative", "declined", "needsAction"];
const responseOf = (v: unknown): meeting.MeetingResponseStatus =>
  RESPONSE_ORDER.includes(v as meeting.MeetingResponseStatus) ? (v as meeting.MeetingResponseStatus) : "needsAction";

/** Google's id of one occurrence of a recurring event: `<eventId>_<UTC start, basic format>`. */
export function instanceIdFor(eventId: string, startsAt: string): string {
  return `${eventId}_${new Date(startsAt).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
}

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

/** Hash, not the list itself: the state needs no addresses to tell that the list changed. */
async function fingerprintOf(desired: Set<string>, ownerEmail: string | null): Promise<string> {
  const text = JSON.stringify([ownerEmail, ...[...desired].sort()]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  async function invitees(roleId?: string, strict?: boolean): Promise<Invitee[]> {
    const users = await deps.roster.listActiveUsers(roleId);
    const google = await deps.directory.googleEmails(users.map((u) => u.id), strict ? { strict } : undefined);
    return users.map((u) => {
      const g = google.get(u.id);
      return { userId: u.id, email: lower(g?.gmail ?? u.email), name: u.name, roleIds: u.roleIds, hasGoogle: !!g?.gmail };
    });
  }

  /** One invite per address. After the target filter: two accounts can share a Gmail, and the
   *  one kept must belong to the target, or the sync would uninvite the address. */
  const uniqueEmails = (list: Invitee[]) => [...new Map([...list].reverse().map((i) => [i.email, i])).values()].reverse();

  /** Has a Google account to receive the invite / share (see the header). */
  const reachable = (i: Invitee) => {
    if (!i.hasGoogle) return false;
    const [local, domain] = i.email.split("@");
    return !(domain === ORG_MAIL_DOMAIN && NON_PERSONAL_LOCAL_PARTS.has(local ?? ""));
  };

  const membersOf = (all: Invitee[], targetId: string) =>
    targetId === meeting.ALL_MEMBERS_TARGET_ID ? all : all.filter((i) => i.roleIds.includes(targetId));

  const forTarget = (all: Invitee[], targetId: string) => uniqueEmails(membersOf(all, targetId).filter(reachable));

  const inviteesOf = async (targetId: string) =>
    forTarget(await invitees(targetId === meeting.ALL_MEMBERS_TARGET_ID ? undefined : targetId), targetId);

  /** Open the Meet without holding the response; the sync retries one that did not get through. */
  async function openMeetAfterResponse(account: MeetingAccount, meetUrl: string | null): Promise<void> {
    const work = openMeet(account.calendar, account, meetUrl);
    if (deps.background) deps.background(work);
    else await work;
  }

  /** targetId → Google calendar id on the current account; empty when the account cannot be read. */
  async function myCalendarIds(): Promise<Map<string, string>> {
    try {
      const account = await deps.account();
      return new Map((await store.listCalendars(orgId, account.accountId)).map((c) => [c.targetId, c.calendarId]));
    } catch (err) {
      log("meeting_target_calendars_failed", { message: err instanceof Error ? err.message : String(err) });
      return new Map();
    }
  }

  /** The target's calendar on this account, created on first use. */
  async function ensureCalendar(cal: CalendarClient, accountId: string, targetId: string, name: string): Promise<string> {
    const existing = await store.getCalendar(orgId, targetId, accountId);
    if (existing) return existing.calendarId;
    const created = await cal.createCalendar(name, meeting.MEETING_TIME_ZONE);
    const row = await store.insertCalendar({ orgId, targetId, accountId, calendarId: created.id, createdAt: deps.now() });
    return row.calendarId;
  }

  /** Past the last occurrence (a series with no end date never is). */
  const isOver = (m: MeetingFields, nowMs: number) => {
    const end = lastEndMs(m);
    return end !== null && nowMs >= end;
  };

  /** Still worth reading from Google. */
  const inSync = (m: MeetingRow, nowMs: number) => {
    const end = lastEndMs(m);
    return end === null || nowMs < end + ENDED_SYNC_GRACE_MS;
  };

  /** Share one calendar read-only with exactly `desired` (plus whatever was shared by hand). `st` is
   *  updated in place, so the caller saves what was learned even when this throws. */
  async function reconcileAcl(
    cal: CalendarClient,
    calendarId: string,
    desired: Set<string>,
    ownerEmail: string | null,
    st: CalendarAclState,
    pace: { left: number; deferred: boolean },
    nowMs: number,
  ): Promise<void> {
    const fingerprint = await fingerprintOf(desired, ownerEmail);
    const retryDue = Object.values(st.retryAt).some((at) => at <= nowMs);
    if (st.fingerprint === fingerprint && nowMs - st.checkedAt < ACL_FULL_CHECK_MS && !retryDue) return;
    if (pace.left <= 0) {
      pace.deferred = true;
      return;
    }
    const rules = await cal.listAcl(calendarId);
    const shared = new Set(rules.map((r) => r.email).filter((e): e is string => !!e));
    const ledger = await store.listAcl(orgId, calendarId);
    const writes: { key: string; email: string; op: () => Promise<void> }[] = [];
    for (const email of desired) {
      if (shared.has(email) || email === ownerEmail) continue;
      writes.push({
        key: `add:${email}`,
        email,
        op: async () => {
          const rule = await cal.insertAcl(calendarId, email);
          await store.putAcl({ orgId, calendarId, email, ruleId: rule.id });
        },
      });
    }
    for (const row of ledger) {
      if (desired.has(row.email)) continue;
      writes.push({
        key: `remove:${row.email}`,
        email: row.email,
        op: async () => {
          await cal.deleteAcl(calendarId, row.ruleId);
          await store.removeAcl(orgId, calendarId, row.email);
        },
      });
    }
    // A wait ends with what it was for: someone who left and rejoined is tried at once.
    const wanted = new Set(writes.map((w) => w.key));
    for (const key of Object.keys(st.retryAt)) if (!wanted.has(key)) delete st.retryAt[key];

    const due = writes.filter((w) => (st.retryAt[w.key] ?? 0) <= nowMs);
    const batch = due.slice(0, pace.left);
    for (const w of batch) {
      pace.left--;
      try {
        await w.op();
        delete st.retryAt[w.key];
      } catch (err) {
        if (err instanceof BudgetExhausted || isCalendarQuota(err)) throw err;
        // One address Google refuses (e.g. it cannot take a share) must not block the others.
        st.retryAt[w.key] = nowMs + ACL_RETRY_WAIT_MS;
        log("meeting_calendar_acl_failed", { calendarId, email: w.email, message: err instanceof Error ? err.message : String(err) });
      }
    }
    if (batch.length < due.length) {
      pace.deferred = true;
      return; // unfinished: no fingerprint, so the continuation comes back here
    }
    st.fingerprint = fingerprint;
    st.checkedAt = nowMs;
  }

  /** Mirror Google's state of one meeting into D1, then bring its attendees in line with its target. */
  async function reconcileMeeting(
    cal: CalendarClient,
    row: MeetingRow,
    desired: Invitee[],
  ): Promise<{ added: number; removed: number }> {
    let m = row;
    let ev = await cal.getEvent(m.calendarId, m.googleEventId);
    const nowMs = Date.parse(deps.now());
    if (!ev && m.syncedAt === null && isOver(m, nowMs)) {
      // Finishing the create now would mail an invitation to a meeting that has passed.
      log("meeting_sync_create_past_skipped", { meetingId: m.id });
      return { added: 0, removed: 0 };
    }
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
    if (isOver(m, nowMs)) {
      // Judged after the pull: a meeting moved forward in Google is live again.
      if (ev.recurrence?.length && !fromRecurrence(ev.recurrence)) log("meeting_sync_recurrence_unrepresentable", { meetingId: m.id });
      await store.updateMeetingIf({ ...m, meetUrl: m.meetUrl ?? ev.meetUrl, htmlLink: m.htmlLink ?? ev.htmlLink, syncedAt: deps.now() }, row.updatedAt);
      return { added: 0, removed: 0 };
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

  /** The share step of the sync. Returns ms until a continuation is due, null = nothing left. What
   *  was learned is saved even when a limit ends the step midway. */
  async function syncShares(cal: CalendarClient, account: MeetingAccount, all: Invitee[], state: MeetingSyncSnapshot): Promise<number | null> {
    const nowMs = Date.parse(deps.now());
    if (state.aclWritesNotBefore > nowMs) return state.aclWritesNotBefore - nowMs;
    // Same reading as the attendees' empty target: a glitch, never a reason to unshare everyone.
    if (all.length === 0) {
      log("meeting_sync_empty_members_skipped", {});
      return null;
    }
    const owner = account.email ? lower(account.email) : null;
    const pace = { left: ACL_WRITES_PER_RUN, deferred: false };
    const touched: Record<string, CalendarAclState> = {};
    let sharesPausedUntil: number | null = null;
    try {
      for (const c of await store.listCalendars(orgId, account.accountId)) {
        const st: CalendarAclState = { fingerprint: null, checkedAt: 0, ...state.acl[c.calendarId], retryAt: { ...state.acl[c.calendarId]?.retryAt } };
        const before = JSON.stringify(st);
        const desired = new Set(forTarget(all, c.targetId).map((i) => i.email));
        try {
          // A role with no members at all keeps its shares, as its meetings keep their attendees:
          // likelier a glitch than a role emptied on purpose.
          if (membersOf(all, c.targetId).length === 0) {
            log("meeting_calendar_empty_target_skipped", { calendarId: c.calendarId, targetId: c.targetId });
            continue;
          }
          await reconcileAcl(cal, c.calendarId, desired, owner, st, pace, nowMs);
        } catch (err) {
          if (err instanceof BudgetExhausted) {
            pace.deferred = true; // the paced continuation, not the two-minute one
            break;
          }
          if (isCalendarQuota(err)) {
            // Shares only: a share limit must not hold back the invites of people who just joined a role.
            sharesPausedUntil = nowMs + QUOTA_PAUSE_MS;
            log("meeting_shares_quota_paused", { pausedUntil: new Date(sharesPausedUntil).toISOString(), reason: err.reason, operation: err.operation, googleMessage: err.googleMessage });
            break;
          }
          log("meeting_calendar_acl_sync_failed", { calendarId: c.calendarId, message: err instanceof Error ? err.message : String(err) });
        } finally {
          if (JSON.stringify(st) !== before) touched[c.calendarId] = st;
        }
      }
    } finally {
      const notBefore = sharesPausedUntil ?? (pace.deferred ? nowMs + ACL_WRITE_INTERVAL_MS : null);
      await syncState
        .save({ acl: touched, ...(notBefore !== null ? { aclWritesNotBefore: notBefore } : {}) })
        .catch((err: unknown) => log("meeting_acl_state_save_failed", { message: err instanceof Error ? err.message : String(err) }));
    }
    if (sharesPausedUntil !== null) return QUOTA_PAUSE_MS;
    return pace.deferred ? ACL_WRITE_INTERVAL_MS : null;
  }

  /** The Meet step of the sync (Meet REST, not Calendar: it also runs during a pause). */
  async function openMeets(cal: CalendarClient, account: MeetingAccount): Promise<void> {
    const nowMs = Date.parse(deps.now());
    // Re-read: reconcile may have just filled in a Meet link.
    try {
      for (const m of await store.listMeetings(orgId)) {
        if (m.accountId === account.accountId && inSync(m, nowMs)) await openMeet(cal, account, m.meetUrl);
      }
    } catch (err) {
      if (!(err instanceof BudgetExhausted)) throw err;
    }
  }

  const service: MeetingsService = {
    async list() {
      const [rows, counts, regulars] = await Promise.all([store.listMeetings(orgId), store.inviteCounts(orgId), deps.attendance.listRegularIds(orgId)]);
      // Ended meetings never move syncedAt again: counting them would kick on every list.
      const nowMs = Date.parse(deps.now());
      const synced = rows.filter((r) => inSync(r, nowMs));
      const lastSync = Math.max(0, ...synced.map((r) => (r.syncedAt ? Date.parse(r.syncedAt) : 0)));
      if (synced.length > 0 && nowMs - lastSync > LIST_KICK_MIN_GAP_MS) await kick(LIST_SOON_MS);
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
      const [roles, users, calendars] = await Promise.all([deps.roster.listRoles(), deps.roster.listActiveUsers(), myCalendarIds()]);
      const me = users.find((u) => u.id === userId);
      const items: meeting.MeetingTarget[] = [
        { id: meeting.ALL_MEMBERS_TARGET_ID, name: ALL_TARGET_NAME, memberCount: users.length, isMine: true },
        ...roles.map((r) => ({
          id: r.id,
          name: r.name,
          memberCount: users.filter((u) => u.roleIds.includes(r.id)).length,
          isMine: !!me?.roleIds.includes(r.id),
        })),
      ].map((t) => {
        // Only the caller's own calendars: those are the ones shared with them (no share mail any more).
        const calendarId = t.isMine ? calendars.get(t.id) : undefined;
        return calendarId ? { ...t, calendarId } : t;
      });
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

    async attendees(id, date) {
      if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw errors.validationFailed([{ field: "date", reason: "invalid" }], "日付の形式が正しくありません。");
      }
      const row = await store.getMeeting(orgId, id);
      if (!row) throw errors.notFound("meeting", id);
      const [ledger, users] = await Promise.all([store.listInvites(row.id), deps.roster.listActiveUsers()]);
      const nameOf = new Map(users.map((u) => [u.id, u.name]));
      const byEmail = new Map(ledger.map((r) => [r.email, r]));

      // Read-only and best-effort: answers are a nicety, the invitee list must still show.
      let ev: CalendarEvent | null = null;
      let available = false;
      try {
        const [account, state] = await Promise.all([deps.account(), syncState.load()]);
        const paused = state.pausedUntil !== null && state.pausedUntil > Date.parse(deps.now());
        if (account.calendarReady && account.accountId === row.accountId && !paused && row.syncedAt !== null) {
          const cal = budgeted(account.calendar, 2);
          const occ = date && row.recurrence !== "none" ? meeting.occurrenceStarts(row, date, date)[0] : undefined;
          if (occ) ev = await cal.getEvent(row.calendarId, instanceIdFor(row.googleEventId, occ.startsAt));
          ev ??= await cal.getEvent(row.calendarId, row.googleEventId);
          available = ev !== null;
        }
      } catch (err) {
        if (isCalendarQuota(err)) await pauseSync(err);
        log("meeting_attendees_read_failed", { meetingId: id, message: err instanceof Error ? err.message : String(err) });
      }

      const items: meeting.MeetingAttendee[] = [];
      const seen = new Set<string>();
      for (const a of ev?.attendees ?? []) {
        // The shared account itself (organizer) and rooms are not people invited.
        if (a.self === true || a.resource === true) continue;
        const email = lower(a.email);
        if (seen.has(email)) continue;
        seen.add(email);
        const inv = byEmail.get(email);
        const comment = typeof a.comment === "string" && a.comment.trim() ? a.comment.trim() : null;
        const displayName = typeof a.displayName === "string" && a.displayName.trim() ? a.displayName.trim() : null;
        items.push(
          inv?.userId
            ? { userId: inv.userId as meeting.MeetingAttendee["userId"], name: nameOf.get(inv.userId) ?? displayName ?? email, email: null, response: responseOf(a.responseStatus), comment }
            : { userId: null, name: displayName ?? email, email, response: responseOf(a.responseStatus), comment },
        );
      }
      // Invited by Dub but not (yet) on the event Google returned: still invited, no answer.
      for (const r of ledger) {
        if (seen.has(r.email)) continue;
        items.push({ userId: (r.userId ?? null) as meeting.MeetingAttendee["userId"], name: (r.userId && nameOf.get(r.userId)) || r.email, email: r.userId ? null : r.email, response: "needsAction", comment: null });
      }
      items.sort((x, y) => RESPONSE_ORDER.indexOf(x.response) - RESPONSE_ORDER.indexOf(y.response) || x.name.localeCompare(y.name, "ja"));
      return { items, responsesAvailable: available };
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
      // Strict: without the 名簿 every Gmail would read as changed, and the sync would swap all
      // invites and shares to login addresses, then back, mailing everyone both ways.
      const all = await invitees(undefined, true);
      const out: SyncResult = { ...empty, withoutGoogleAccount: uniqueEmails(all).filter((i) => !i.hasGoogle).map((i) => ({ userId: i.userId, name: i.name, email: i.email })) };

      try {
        if (!opts?.aclOnly) {
          const nowMs = Date.parse(syncedAt);
          const rows = (await store.listMeetings(orgId)).filter((m) => m.accountId === account.accountId && inSync(m, nowMs));
          let stoppedAt: string | null = null;
          for (const m of rows.slice(Math.max(0, rows.findIndex((r) => r.id === state.meetingCursor)))) {
            try {
              const r = await reconcileMeeting(cal, m, forTarget(all, m.targetId));
              out.meetings++;
              out.invitedAdded += r.added;
              out.invitedRemoved += r.removed;
            } catch (err) {
              if (err instanceof BudgetExhausted) {
                stoppedAt = m.id;
                break;
              }
              if (isCalendarQuota(err)) throw err;
              log("meeting_sync_failed", { meetingId: m.id, message: err instanceof Error ? err.message : String(err) });
            }
          }
          out.complete = stoppedAt === null;
          if (stoppedAt !== state.meetingCursor) await syncState.save({ meetingCursor: stoppedAt });
        }

        if (out.complete) {
          const continueMs = await syncShares(cal, account, all, state);
          if (continueMs !== null) out.aclContinueMs = continueMs;
        }
      } catch (err) {
        if (!isCalendarQuota(err)) throw err;
        const until = await pauseSync(err);
        if (!opts?.system) throw err;
        return { ...out, ...(until === null ? {} : { quotaPausedUntil: until }) };
      }

      if (opts?.aclOnly) return out;
      // Best-effort, and hourly is often enough: running out here is no reason to run again.
      if (out.complete && account.meetReady) await openMeets(cal, account);
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
