// REAL Google Calendar v3 client (カレンダー > ミーティング) — the ONLY place raw Calendar calls
// live. Raw fetch like ./client.ts: every non-2xx goes through mapGoogleError, a 401 triggers
// one forced token refresh + retry. Event writes always pass sendUpdates=all so attendees get
// Google's own invitation / update / cancellation mail; calendar shares (ACL) never mail.
import { errors } from "@dub/errors";
import { retryFetch } from "@dub/http";
import { mapGoogleError, type GoogleErrorSource } from "../drive-client";
import type { GoogleCallRecorder } from "./api-usage";
import type { TokenProvider } from "./token";

const CAL_BASE = "https://www.googleapis.com/calendar/v3";
const MEET_BASE = "https://meet.googleapis.com/v2";
/** 429 is a usage limit here: retrying it within the call only spends more of that limit. */
const RETRY_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);
const retryOn = ({ status, error }: { status?: number; error?: unknown }): boolean => error !== undefined || (status !== undefined && RETRY_STATUSES.has(status));

/** "abc-defg-hij" from a Meet link, null when it is not one. */
export function meetingCodeOf(meetUrl: string): string | null {
  return /^https:\/\/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)(?:[/?#]|$)/i.exec(meetUrl)?.[1] ?? null;
}

/** insertEvent with an id Google already used for an event that is now deleted (ids are never reused). */
export class EventIdTaken extends Error {
  constructor(eventId: string) {
    super(`event id already used: ${eventId}`);
    this.name = "EventIdTaken";
  }
}

export interface CalendarAttendee {
  email: string;
  /** Every other attendee field Google returned (responseStatus, …), kept on patch. */
  [k: string]: unknown;
}

export interface CalendarEventInput {
  /** Client-chosen event id (base32hex). Makes insert idempotent: a retry returns the event. */
  id?: string;
  summary: string;
  description: string | null;
  /** RFC 3339 (UTC ISO is fine; the zone below drives recurrence expansion). */
  start: string;
  end: string;
  timeZone: string;
  /** ["RRULE:…"] or [] for a one-off. */
  recurrence: string[];
  attendees: CalendarAttendee[];
}

export interface CalendarEvent {
  id: string;
  htmlLink: string | null;
  meetUrl: string | null;
  attendees: CalendarAttendee[];
  /** Event fields as Google holds them now (absent = unknown); reconcile mirrors edits made there. */
  summary?: string;
  description?: string | null;
  /** UTC ISO; absent for an all-day event. */
  start?: string;
  end?: string;
  recurrence?: string[];
}

export interface CalendarAclRule {
  id: string;
  role: string;
  /** scope.type "user" => the address; null for default/domain scopes. */
  email: string | null;
}

export interface CalendarClient {
  createCalendar(summary: string, timeZone: string): Promise<{ id: string }>;
  listAcl(calendarId: string): Promise<CalendarAclRule[]>;
  /** Share the calendar read-only with one address. */
  insertAcl(calendarId: string, email: string): Promise<{ id: string }>;
  /** Idempotent: an already-removed rule is success. */
  deleteAcl(calendarId: string, ruleId: string): Promise<void>;
  /** Creates the event with a new Google Meet link. With `input.id`, an existing event of that
   *  id is returned instead (retry after an interrupted insert). */
  insertEvent(calendarId: string, input: CalendarEventInput): Promise<CalendarEvent>;
  /** null = the event no longer exists (404/410). */
  getEvent(calendarId: string, eventId: string): Promise<CalendarEvent | null>;
  patchEvent(calendarId: string, eventId: string, patch: Partial<CalendarEventInput>): Promise<CalendarEvent>;
  /** Idempotent: 404/410 (already gone) is success. */
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
  /** Meet REST v2: let anyone with the link join without knocking (accessType OPEN). Calendar
   *  cannot set this, so it is applied to the space after the event exists. false = not a Meet link. */
  openMeet(meetUrl: string): Promise<boolean>;
}

interface GoogleEvent {
  id?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  recurrence?: string[];
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  attendees?: CalendarAttendee[];
}

const isoOf = (v: string | undefined): string | undefined => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

export function mapEvent(e: GoogleEvent): CalendarEvent {
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
  const ev: CalendarEvent = {
    id: e.id ?? "",
    htmlLink: e.htmlLink ?? null,
    meetUrl: e.hangoutLink ?? video ?? null,
    attendees: (e.attendees ?? []).filter((a) => typeof a.email === "string"),
    summary: e.summary ?? "",
    description: e.description?.trim() ? e.description.trim() : null,
    recurrence: e.recurrence ?? [],
  };
  const start = isoOf(e.start?.dateTime);
  const end = isoOf(e.end?.dateTime);
  if (start) ev.start = start;
  if (end) ev.end = end;
  return ev;
}

function eventBody(p: Partial<CalendarEventInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (p.id !== undefined) body.id = p.id;
  if (p.summary !== undefined) body.summary = p.summary;
  if (p.description !== undefined) body.description = p.description ?? "";
  if (p.start !== undefined) body.start = { dateTime: p.start, timeZone: p.timeZone };
  if (p.end !== undefined) body.end = { dateTime: p.end, timeZone: p.timeZone };
  if (p.recurrence !== undefined) body.recurrence = p.recurrence;
  if (p.attendees !== undefined) body.attendees = p.attendees;
  return body;
}

export function createGoogleCalendarClient(deps: { token: TokenProvider; fetchImpl?: typeof fetch; newRequestId?: () => string; recordCall?: GoogleCallRecorder }): CalendarClient {
  const doFetch = deps.fetchImpl ?? ((input: string | URL | Request, init?: RequestInit) => retryFetch(input, { ...init, retry: { retryOn } }));
  const requestId = deps.newRequestId ?? (() => crypto.randomUUID());

  async function call(url: string, init: RequestInit): Promise<Response> {
    const attempt = async (forceRefresh: boolean): Promise<Response> => {
      const token = await deps.token.getAccessToken(forceRefresh ? { forceRefresh: true } : undefined);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      if (init.body !== undefined) headers.set("content-type", "application/json");
      await deps.recordCall?.(url.startsWith(MEET_BASE) ? "meet" : "calendar");
      try {
        return await doFetch(url, { ...init, headers });
      } catch (cause) {
        const aborted = cause instanceof Error && cause.name === "AbortError";
        throw aborted ? errors.upstreamTimeout("google", cause) : errors.upstreamUnavailable("google", cause);
      }
    };
    let res = await attempt(false);
    if (res.status === 401) res = await attempt(true);
    return res;
  }

  async function fail(res: Response, source: GoogleErrorSource): Promise<never> {
    const body = await res.json().catch(() => null);
    throw mapGoogleError(res.status, body, source);
  }

  /** `operation` = the Calendar method; pass a Meet source for Meet REST (its own quota). */
  async function readJson<T>(res: Response, operation: string | GoogleErrorSource): Promise<T> {
    if (!res.ok) await fail(res, typeof operation === "string" ? { api: "calendar", operation } : operation);
    return (await res.json().catch(() => ({}))) as T;
  }

  const gone = (status: number) => status === 404 || status === 410;
  const cal = (id: string) => `${CAL_BASE}/calendars/${encodeURIComponent(id)}`;

  const client: CalendarClient = {
    async createCalendar(summary, timeZone) {
      const res = await call(`${CAL_BASE}/calendars`, { method: "POST", body: JSON.stringify({ summary, timeZone }) });
      const json = await readJson<{ id?: string }>(res, "calendars.insert");
      if (!json.id) throw errors.upstreamUnavailable("google:calendar");
      return { id: json.id };
    },

    async listAcl(calendarId) {
      const rules: CalendarAclRule[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL(`${cal(calendarId)}/acl`);
        url.searchParams.set("maxResults", "250");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const json = await readJson<{ items?: { id?: string; role?: string; scope?: { type?: string; value?: string } }[]; nextPageToken?: string }>(
          await call(url.toString(), { method: "GET" }),
          "acl.list",
        );
        for (const r of json.items ?? []) {
          if (!r.id) continue;
          rules.push({ id: r.id, role: r.role ?? "", email: r.scope?.type === "user" && r.scope.value ? r.scope.value.toLowerCase() : null });
        }
        pageToken = json.nextPageToken;
      } while (pageToken);
      return rules;
    },

    async insertAcl(calendarId, email) {
      // No share mail: Google's default (true) mailed every member once per calendar. Members
      // add the calendar from Dub instead (カレンダー > ミーティング「Googleカレンダーに追加」).
      const url = new URL(`${cal(calendarId)}/acl`);
      url.searchParams.set("sendNotifications", "false");
      const res = await call(url.toString(), {
        method: "POST",
        body: JSON.stringify({ role: "reader", scope: { type: "user", value: email } }),
      });
      const json = await readJson<{ id?: string }>(res, "acl.insert");
      if (!json.id) throw errors.upstreamUnavailable("google:calendar");
      return { id: json.id };
    },

    async deleteAcl(calendarId, ruleId) {
      const res = await call(`${cal(calendarId)}/acl/${encodeURIComponent(ruleId)}`, { method: "DELETE" });
      if (res.ok || gone(res.status)) return;
      await fail(res, { api: "calendar", operation: "acl.delete" });
    },

    async insertEvent(calendarId, input) {
      const url = new URL(`${cal(calendarId)}/events`);
      url.searchParams.set("conferenceDataVersion", "1");
      url.searchParams.set("sendUpdates", "all");
      const body = {
        ...eventBody(input),
        conferenceData: { createRequest: { requestId: requestId(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
      };
      const res = await call(url.toString(), { method: "POST", body: JSON.stringify(body) });
      if (res.status === 409 && input.id) {
        // Already inserted by an earlier, interrupted attempt. A deleted event's id stays taken.
        const existing = await client.getEvent(calendarId, input.id);
        if (existing) return existing;
        throw new EventIdTaken(input.id);
      }
      return mapEvent(await readJson<GoogleEvent>(res, "events.insert"));
    },

    async getEvent(calendarId, eventId) {
      const res = await call(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "GET" });
      if (gone(res.status)) return null;
      const json = await readJson<GoogleEvent & { status?: string }>(res, "events.get");
      // A deleted event can still be read back with status "cancelled".
      return json.status === "cancelled" ? null : mapEvent(json);
    },

    async patchEvent(calendarId, eventId, patch) {
      const url = new URL(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}`);
      url.searchParams.set("sendUpdates", "all");
      url.searchParams.set("conferenceDataVersion", "1");
      return mapEvent(await readJson<GoogleEvent>(await call(url.toString(), { method: "PATCH", body: JSON.stringify(eventBody(patch)) }), "events.patch"));
    },

    async deleteEvent(calendarId, eventId) {
      const url = new URL(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}`);
      url.searchParams.set("sendUpdates", "all");
      const res = await call(url.toString(), { method: "DELETE" });
      if (res.ok || gone(res.status)) return;
      await fail(res, { api: "calendar", operation: "events.delete" });
    },

    async openMeet(meetUrl) {
      const code = meetingCodeOf(meetUrl);
      if (!code) return false;
      // A meeting code is an alias of the space; patch needs its real name ("spaces/…").
      const space = await readJson<{ name?: string; config?: { accessType?: string } }>(
        await call(`${MEET_BASE}/spaces/${encodeURIComponent(code)}`, { method: "GET" }),
        { api: "meet", operation: "spaces.get" },
      );
      if (space.config?.accessType === "OPEN") return true;
      if (!space.name || !/^spaces\/[\w-]+$/.test(space.name)) throw errors.upstreamUnavailable("google:meet");
      const url = new URL(`${MEET_BASE}/${space.name}`);
      url.searchParams.set("updateMask", "config.accessType");
      await readJson(await call(url.toString(), { method: "PATCH", body: JSON.stringify({ config: { accessType: "OPEN" } }) }), { api: "meet", operation: "spaces.patch" });
      return true;
    },
  };
  return client;
}
