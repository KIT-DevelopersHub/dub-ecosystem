// REAL Google Calendar v3 client (カレンダー > ミーティング) — the ONLY place raw Calendar calls
// live. Raw fetch like ./client.ts: every non-2xx goes through mapGoogleError, a 401 triggers
// one forced token refresh + retry. Event writes always pass sendUpdates=all so attendees get
// Google's own invitation / update / cancellation mail.
import { errors } from "@dub/errors";
import { retryFetch } from "@dub/http";
import { mapGoogleError } from "../drive-client";
import type { TokenProvider } from "./token";

const CAL_BASE = "https://www.googleapis.com/calendar/v3";

export interface CalendarAttendee {
  email: string;
  /** Every other attendee field Google returned (responseStatus, …), kept on patch. */
  [k: string]: unknown;
}

export interface CalendarEventInput {
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
  /** Creates the event with a new Google Meet link. */
  insertEvent(calendarId: string, input: CalendarEventInput): Promise<CalendarEvent>;
  /** null = the event no longer exists (404/410). */
  getEvent(calendarId: string, eventId: string): Promise<CalendarEvent | null>;
  patchEvent(calendarId: string, eventId: string, patch: Partial<CalendarEventInput>): Promise<CalendarEvent>;
  /** Idempotent: 404/410 (already gone) is success. */
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

interface GoogleEvent {
  id?: string;
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  attendees?: CalendarAttendee[];
}

export function mapEvent(e: GoogleEvent): CalendarEvent {
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
  return {
    id: e.id ?? "",
    htmlLink: e.htmlLink ?? null,
    meetUrl: e.hangoutLink ?? video ?? null,
    attendees: (e.attendees ?? []).filter((a) => typeof a.email === "string"),
  };
}

function eventBody(p: Partial<CalendarEventInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (p.summary !== undefined) body.summary = p.summary;
  if (p.description !== undefined) body.description = p.description ?? "";
  if (p.start !== undefined) body.start = { dateTime: p.start, timeZone: p.timeZone };
  if (p.end !== undefined) body.end = { dateTime: p.end, timeZone: p.timeZone };
  if (p.recurrence !== undefined) body.recurrence = p.recurrence;
  if (p.attendees !== undefined) body.attendees = p.attendees;
  return body;
}

export function createGoogleCalendarClient(deps: { token: TokenProvider; fetchImpl?: typeof fetch; newRequestId?: () => string }): CalendarClient {
  const doFetch = deps.fetchImpl ?? ((input: string | URL | Request, init?: RequestInit) => retryFetch(input, init));
  const requestId = deps.newRequestId ?? (() => crypto.randomUUID());

  async function call(url: string, init: RequestInit): Promise<Response> {
    const attempt = async (forceRefresh: boolean): Promise<Response> => {
      const token = await deps.token.getAccessToken(forceRefresh ? { forceRefresh: true } : undefined);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      if (init.body !== undefined) headers.set("content-type", "application/json");
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

  async function fail(res: Response): Promise<never> {
    const body = await res.json().catch(() => null);
    throw mapGoogleError(res.status, body, Number(res.headers.get("retry-after")) || undefined);
  }

  async function readJson<T>(res: Response): Promise<T> {
    if (!res.ok) await fail(res);
    return (await res.json().catch(() => ({}))) as T;
  }

  const gone = (status: number) => status === 404 || status === 410;
  const cal = (id: string) => `${CAL_BASE}/calendars/${encodeURIComponent(id)}`;

  return {
    async createCalendar(summary, timeZone) {
      const res = await call(`${CAL_BASE}/calendars`, { method: "POST", body: JSON.stringify({ summary, timeZone }) });
      const json = await readJson<{ id?: string }>(res);
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
      // sendNotifications stays at Google's default (true): the share mail carries the
      // "add this calendar" link members use to show it in their own calendar list.
      const res = await call(`${cal(calendarId)}/acl`, {
        method: "POST",
        body: JSON.stringify({ role: "reader", scope: { type: "user", value: email } }),
      });
      const json = await readJson<{ id?: string }>(res);
      if (!json.id) throw errors.upstreamUnavailable("google:calendar");
      return { id: json.id };
    },

    async deleteAcl(calendarId, ruleId) {
      const res = await call(`${cal(calendarId)}/acl/${encodeURIComponent(ruleId)}`, { method: "DELETE" });
      if (res.ok || gone(res.status)) return;
      await fail(res);
    },

    async insertEvent(calendarId, input) {
      const url = new URL(`${cal(calendarId)}/events`);
      url.searchParams.set("conferenceDataVersion", "1");
      url.searchParams.set("sendUpdates", "all");
      const body = {
        ...eventBody(input),
        conferenceData: { createRequest: { requestId: requestId(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
      };
      return mapEvent(await readJson<GoogleEvent>(await call(url.toString(), { method: "POST", body: JSON.stringify(body) })));
    },

    async getEvent(calendarId, eventId) {
      const res = await call(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "GET" });
      if (gone(res.status)) return null;
      const json = await readJson<GoogleEvent & { status?: string }>(res);
      // A deleted event can still be read back with status "cancelled".
      return json.status === "cancelled" ? null : mapEvent(json);
    },

    async patchEvent(calendarId, eventId, patch) {
      const url = new URL(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}`);
      url.searchParams.set("sendUpdates", "all");
      url.searchParams.set("conferenceDataVersion", "1");
      return mapEvent(await readJson<GoogleEvent>(await call(url.toString(), { method: "PATCH", body: JSON.stringify(eventBody(patch)) })));
    },

    async deleteEvent(calendarId, eventId) {
      const url = new URL(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}`);
      url.searchParams.set("sendUpdates", "all");
      const res = await call(url.toString(), { method: "DELETE" });
      if (res.ok || gone(res.status)) return;
      await fail(res);
    },
  };
}
