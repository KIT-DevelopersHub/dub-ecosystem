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
import { errors } from "@dub/errors";
import { meeting } from "@dub/types";
import type { CalendarAttendee, CalendarClient, CalendarEventInput } from "./google/calendar-client";
import type { MemberDirectory } from "./member-directory";
import type { MeetingRow, MeetingStore } from "./meetings-store";
import { endsAt, toRecurrence, validateMeeting, type MeetingFields } from "./meeting-rules";
import type { RoleMembership } from "./role-membership";

export const ALL_TARGET_NAME = "全体";
const SOON_MS = 60_000;
const NO_CALENDAR_SCOPE =
  "Google アカウントにカレンダーの権限がありません。Drive共有 > 設定 で同じアカウントを「再接続」してください。";

/** The Google account meetings are created as, resolved per request. */
export interface MeetingAccount {
  /** driveshare_google_accounts row id, "secret" (refresh-token secret) or "mock". */
  accountId: string;
  email: string | null;
  /** false = the token lacks the calendar scope (or the account is unusable): reconnect. */
  calendarReady: boolean;
  calendar: CalendarClient;
}

export interface MeetingsDeps {
  store: MeetingStore;
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
}

export interface SyncResult extends meeting.SyncMeetingsResponse {
  /** false = stopped at the Google call budget; run again to finish. */
  complete: boolean;
}

export interface MeetingsService {
  list(): Promise<meeting.ListMeetingsResponse>;
  targets(userId: string | undefined): Promise<meeting.ListMeetingTargetsResponse>;
  create(userId: string, body: unknown): Promise<meeting.Meeting>;
  update(id: string, body: unknown): Promise<meeting.Meeting>;
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

/** Wrap a client so it refuses calls once `limit` is spent. */
function budgeted(client: CalendarClient, limit: number): CalendarClient & { exhausted: () => boolean } {
  let left = limit;
  let hit = false;
  const spend = () => {
    if (left <= 0) {
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
  };
}

const lower = (e: string) => e.trim().toLowerCase();

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

function toMeeting(m: MeetingRow, targetName: string, attendeeCount: number): meeting.Meeting {
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
    createdBy: m.createdBy,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

export function createMeetingsService(deps: MeetingsDeps): MeetingsService {
  const { store, orgId } = deps;
  const budgetLimit = deps.googleBudget ?? 25;

  /** After a write: run the sync within a minute (finishes calendar sharing, follows membership). */
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

  /** Every active member with their invite address (one identity listing + one 名簿 lookup). */
  async function invitees(): Promise<Invitee[]> {
    const users = await deps.roster.listActiveUsers();
    const google = await deps.directory.googleEmails(users.map((u) => u.id));
    const out: Invitee[] = [];
    const seen = new Set<string>();
    for (const u of users) {
      const g = google.get(u.id);
      const email = lower(g?.gmail ?? u.email);
      if (seen.has(email)) continue;
      seen.add(email);
      out.push({ userId: u.id, email, name: u.name, roleIds: u.roleIds, hasGoogle: !!g?.gmail });
    }
    return out;
  }

  const forTarget = (all: Invitee[], targetId: string) =>
    targetId === meeting.ALL_MEMBERS_TARGET_ID ? all : all.filter((i) => i.roleIds.includes(targetId));

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
        if (err instanceof BudgetExhausted) throw err;
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

  /** Bring one meeting's attendees in line with its target. */
  async function reconcileMeeting(
    cal: CalendarClient,
    m: MeetingRow,
    desired: Invitee[],
  ): Promise<{ added: number; removed: number }> {
    const ledger = await store.listInvites(m.id);
    // An empty target with invites on record is far more likely a transient identity glitch than
    // a role emptied on purpose — never mass-uninvite on it.
    if (desired.length === 0 && ledger.length > 0) {
      log("meeting_sync_empty_target_skipped", { meetingId: m.id, targetId: m.targetId });
      return { added: 0, removed: 0 };
    }
    const ev = await cal.getEvent(m.calendarId, m.googleEventId);
    if (!ev) {
      log("meeting_sync_event_gone", { meetingId: m.id });
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
    await store.updateMeeting({ ...next, syncedAt: deps.now() });
    return { added: toAdd.length, removed: removedFromEvent };
  }

  async function shareTargetCalendar(cal: CalendarClient, account: MeetingAccount, calendarId: string, all: Invitee[]): Promise<void> {
    try {
      await reconcileAcl(cal, calendarId, new Set(all.map((i) => i.email)), account.email ? lower(account.email) : null);
    } catch (err) {
      // The meeting itself exists; the alarm finishes the sharing.
      if (!(err instanceof BudgetExhausted)) log("meeting_calendar_share_failed", { calendarId, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    async list() {
      const [rows, counts] = await Promise.all([store.listMeetings(orgId), store.inviteCounts(orgId)]);
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
          toMeeting(r, r.targetId === meeting.ALL_MEMBERS_TARGET_ID ? ALL_TARGET_NAME : names.get(r.targetId) ?? "（削除されたロール）", counts.get(r.id) ?? 0),
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
      const name = await requireTargetName(f.targetId);
      const account = await readyAccount();
      const cal = budgeted(account.calendar, budgetLimit);
      const all = await invitees();
      const members = forTarget(all, f.targetId);

      const calendarId = await ensureCalendar(cal, account.accountId, f.targetId, name);
      const ev = await cal.insertEvent(calendarId, { ...eventInput(f), attendees: members.map((m) => ({ email: m.email })) });
      const at = deps.now();
      const row: MeetingRow = {
        id: deps.newId(),
        orgId,
        targetId: f.targetId,
        accountId: account.accountId,
        calendarId,
        googleEventId: ev.id,
        title: f.title,
        description: f.description,
        startsAt: f.startsAt,
        durationMinutes: f.durationMinutes,
        recurrence: f.recurrence,
        until: f.until,
        meetUrl: ev.meetUrl,
        htmlLink: ev.htmlLink,
        createdBy: userId,
        createdAt: at,
        updatedAt: at,
        syncedAt: at,
      };
      try {
        await store.insertMeeting(row);
        await store.replaceInvites(row.id, members.map((m) => ({ meetingId: row.id, email: m.email, userId: m.userId })));
      } catch (err) {
        // Do not leave an event nobody can manage from Dub.
        await account.calendar.deleteEvent(calendarId, ev.id).catch(() => undefined);
        await store.deleteMeeting(row.id).catch(() => undefined);
        throw err;
      }
      await shareTargetCalendar(cal, account, calendarId, all);
      await kick(SOON_MS);
      return toMeeting(row, name, members.length);
    },

    async update(id, body) {
      const row = await store.getMeeting(orgId, id);
      if (!row) throw errors.notFound("meeting", id);
      const f = validateMeeting(body, fieldsOf(row));
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
        const all = await invitees();
        const members = forTarget(all, f.targetId);
        const calendarId = await ensureCalendar(cal, account.accountId, f.targetId, name);
        const ev = await cal.insertEvent(calendarId, { ...eventInput(f), attendees: members.map((m) => ({ email: m.email })) });
        next = { ...row, ...f, calendarId, googleEventId: ev.id, meetUrl: ev.meetUrl, htmlLink: ev.htmlLink, updatedAt: at, syncedAt: at };
        await store.updateMeeting(next);
        await store.replaceInvites(row.id, members.map((m) => ({ meetingId: row.id, email: m.email, userId: m.userId })));
        try {
          await account.calendar.deleteEvent(row.calendarId, row.googleEventId);
        } catch (err) {
          log("meeting_old_event_delete_failed", { meetingId: row.id, message: err instanceof Error ? err.message : String(err) });
        }
        await shareTargetCalendar(cal, account, calendarId, all);
        attendeeCount = members.length;
      } else {
        const ev = await cal.patchEvent(row.calendarId, row.googleEventId, eventInput(f));
        next = { ...row, ...f, meetUrl: ev.meetUrl ?? row.meetUrl, htmlLink: ev.htmlLink ?? row.htmlLink, updatedAt: at };
        await store.updateMeeting(next);
        attendeeCount = (await store.listInvites(row.id)).length;
      }
      await kick(SOON_MS);
      return toMeeting(next, name, attendeeCount);
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
      const cal = budgeted(account.calendar, budgetLimit);
      const all = await invitees();
      const out = { ...empty, withoutGoogleAccount: all.filter((i) => !i.hasGoogle).map((i) => ({ userId: i.userId, name: i.name, email: i.email })) };

      const rows = (await store.listMeetings(orgId)).filter((m) => m.accountId === account.accountId);
      for (const m of rows) {
        try {
          const r = await reconcileMeeting(cal, m, forTarget(all, m.targetId));
          out.meetings++;
          out.invitedAdded += r.added;
          out.invitedRemoved += r.removed;
        } catch (err) {
          if (err instanceof BudgetExhausted) break;
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
            log("meeting_calendar_acl_sync_failed", { calendarId: c.calendarId, message: err instanceof Error ? err.message : String(err) });
          }
        }
      }
      out.complete = !cal.exhausted();
      // Keep the hourly loop alive; an unfinished run continues within a minute.
      if (!opts?.system) await kick(out.complete ? undefined : SOON_MS);
      return out;
    },
  };
}
