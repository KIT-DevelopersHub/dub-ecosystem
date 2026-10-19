// Composition for カレンダー > ミーティング, shared by the Worker entry (per request) and the
// MeetingSyncDO alarm (system actor). The Google account is the one Drive共有 uses
// (resolveDriveCredentials), and the calendar client follows the Drive client's choice: mock
// when Drive is mocked (DRIVESHARE_MOCK or nothing connected), failing when the account is
// unusable, real otherwise.
import { createDbClient, newId, nowIso } from "@dub/db";
import { common } from "@dub/types";
import { createMockCalendarClient, createMockCalendarState } from "./calendar-mock-client";
import { createGoogleCalendarClient, type CalendarClient } from "./google/calendar-client";
import { createTokenProvider, isInvalidGrant } from "./google/token";
import { importTokenKey } from "./google/crypto";
import { createD1GoogleAccountStore } from "./google-account-store";
import { CALENDAR_SCOPE, MEET_SCOPE, reconnectRequired, resolveDriveCredentials, type ResolvedCredentials } from "./google-account";
import { createMemberDirectory } from "./member-directory";
import { createD1MeetingStore } from "./meetings-store";
import { createMeetingsService, type MeetingAccount, type MeetingsService } from "./meetings-service";
import { createIdentityRoleMembership } from "./role-membership";
import { SECRET_ACCOUNT_ID } from "./types";
import { mockForced, type Env } from "./env";

/** Per isolate, so a mocked deployment keeps its calendars between requests. */
const mockCalendarState = createMockCalendarState();
/** Per isolate: Meet links already confirmed open, so the sync checks each one once. */
const openedMeets = new Set<string>();

export const MOCK_ACCOUNT_ID = "mock";

function failingCalendar(): CalendarClient {
  const fail = async (): Promise<never> => {
    throw reconnectRequired();
  };
  return {
    createCalendar: fail,
    listAcl: fail,
    insertAcl: fail,
    deleteAcl: fail,
    insertEvent: fail,
    getEvent: fail,
    patchEvent: fail,
    deleteEvent: fail,
    openMeet: fail,
  };
}

export async function resolveMeetingAccount(env: Env, resolved: ResolvedCredentials, fetchImpl?: typeof fetch): Promise<MeetingAccount> {
  if (mockForced(env) || resolved.source === "none") {
    return { accountId: MOCK_ACCOUNT_ID, email: null, calendarReady: true, meetReady: true, calendar: createMockCalendarClient(mockCalendarState) };
  }
  if (resolved.source === "unusable") {
    return { accountId: resolved.row.id, email: resolved.row.email, calendarReady: false, meetReady: false, calendar: failingCalendar() };
  }
  const token = createTokenProvider({ credentials: resolved.credentials, ...(fetchImpl ? { fetchImpl } : {}) });
  let calendarReady = true;
  let meetReady = true;
  try {
    const scopes = await token.grantedScopes();
    // Google reports the granted scopes on refresh; unknown (null) is given the benefit of the doubt.
    calendarReady = scopes === null || scopes.includes(CALENDAR_SCOPE);
    meetReady = scopes === null || scopes.includes(MEET_SCOPE);
  } catch (err) {
    // A revoked grant needs the same reconnect; a network blip is not the account's fault.
    calendarReady = !isInvalidGrant(err);
    meetReady = calendarReady;
  }
  return {
    accountId: resolved.source === "connected" ? resolved.row.id : SECRET_ACCOUNT_ID,
    email: resolved.source === "connected" ? resolved.row.email : null,
    calendarReady,
    meetReady,
    calendar: createGoogleCalendarClient({ token, ...(fetchImpl ? { fetchImpl } : {}) }),
  };
}

/** Make sure the MeetingSyncDO alarm is scheduled (hourly), or due within `soonMs`
 *  (no binding = no-op). */
export async function kickMeetingSync(env: Env, soonMs?: number): Promise<void> {
  if (!env.MEETING_SYNC) return;
  const stub = env.MEETING_SYNC.get(env.MEETING_SYNC.idFromName(`meetings:${common.DUB_DEFAULT_ORG_ID}`));
  await stub.fetch("https://meeting-sync/kick", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(soonMs === undefined ? {} : { soonMs }),
  });
}

export async function buildMeetingsService(
  env: Env,
  ctx: { requestId: string; userId?: string },
  opts: { system?: boolean; googleBudget?: number; syncTimeLimitMs?: number } = {},
): Promise<MeetingsService> {
  const orgId = common.DUB_DEFAULT_ORG_ID;
  const accountStore = createD1GoogleAccountStore(createDbClient(env.DB, { namespace: "driveshare", requestId: ctx.requestId }));
  const key = await importTokenKey(env.DRIVESHARE_TOKEN_ENC_KEY);
  let account: Promise<MeetingAccount> | null = null;
  const reqCtx = { requestId: ctx.requestId, ...(ctx.userId ? { userId: ctx.userId } : {}) };
  return createMeetingsService({
    store: createD1MeetingStore(createDbClient(env.DB, { namespace: "driveshare", requestId: ctx.requestId })),
    roster: createIdentityRoleMembership(env.SVC_IDENTITY, reqCtx),
    directory: createMemberDirectory(env.SVC_MEMBER, reqCtx),
    account: () => (account ??= resolveDriveCredentials({ env, store: accountStore, orgId, key }).then((r) => resolveMeetingAccount(env, r))),
    orgId,
    now: nowIso,
    newId: () => newId("dsm"),
    openedMeets,
    // The alarm reschedules itself; only request-path writes kick it.
    ...(opts.system ? {} : { kick: (soonMs?: number) => kickMeetingSync(env, soonMs) }),
    ...(opts.googleBudget ? { googleBudget: opts.googleBudget } : {}),
    ...(opts.syncTimeLimitMs ? { syncTimeLimitMs: opts.syncTimeLimitMs } : {}),
  });
}
