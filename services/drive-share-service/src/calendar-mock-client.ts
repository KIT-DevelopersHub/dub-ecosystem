// In-memory MOCK Calendar client, chosen exactly when the Drive client is the mock (no account
// connected, or DRIVESHARE_MOCK forces it) so カレンダー > ミーティング builds, runs and E2Es at $0.
// Mirrors the real client's observable behaviour (Meet link on insert, idempotent deletes,
// cancelled events read back as null).
import type { CalendarAclRule, CalendarClient, CalendarEvent, CalendarEventInput } from "./google/calendar-client";

interface MockCalendar {
  summary: string;
  acl: CalendarAclRule[];
  events: Map<string, CalendarEventInput & { id: string; meetUrl: string }>;
}

export interface MockCalendarState {
  calendars: Map<string, MockCalendar>;
  seq: number;
}

export function createMockCalendarState(): MockCalendarState {
  return { calendars: new Map(), seq: 0 };
}

/** `state` is injectable so a deployed mock keeps its calendars across requests in one isolate
 *  and every unit test gets a fresh one. */
export function createMockCalendarClient(state: MockCalendarState = createMockCalendarState()): CalendarClient & { state: MockCalendarState } {
  const next = (prefix: string) => `${prefix}_${++state.seq}`;
  // Tolerant on purpose: a deployed mock lives per isolate while D1 rows outlive it, so an id
  // this isolate never saw is materialised instead of failing the demo.
  const calendarOf = (id: string): MockCalendar => {
    let c = state.calendars.get(id);
    if (!c) {
      c = { summary: "", acl: [{ id: "user:owner@mock", role: "owner", email: "owner@mock" }], events: new Map() };
      state.calendars.set(id, c);
    }
    return c;
  };
  const toEvent = (calendarId: string, e: CalendarEventInput & { id: string; meetUrl: string }): CalendarEvent => ({
    id: e.id,
    htmlLink: `https://calendar.google.com/calendar/event?eid=${encodeURIComponent(`${e.id} ${calendarId}`)}`,
    meetUrl: e.meetUrl,
    attendees: e.attendees.map((a) => ({ ...a })),
  });

  return {
    state,
    async createCalendar(summary) {
      const id = `${next("cal")}@group.calendar.google.com`;
      state.calendars.set(id, { summary, acl: [{ id: "user:owner@mock", role: "owner", email: "owner@mock" }], events: new Map() });
      return { id };
    },
    async listAcl(calendarId) {
      return calendarOf(calendarId).acl.map((r) => ({ ...r }));
    },
    async insertAcl(calendarId, email) {
      const c = calendarOf(calendarId);
      const id = `user:${email}`;
      if (!c.acl.some((r) => r.id === id)) c.acl.push({ id, role: "reader", email: email.toLowerCase() });
      return { id };
    },
    async deleteAcl(calendarId, ruleId) {
      const c = state.calendars.get(calendarId);
      if (c) c.acl = c.acl.filter((r) => r.id !== ruleId);
    },
    async insertEvent(calendarId, input) {
      const c = calendarOf(calendarId);
      const id = next("evt");
      const ev = { ...input, attendees: input.attendees.map((a) => ({ ...a })), id, meetUrl: `https://meet.google.com/mock-${id}` };
      c.events.set(id, ev);
      return toEvent(calendarId, ev);
    },
    async getEvent(calendarId, eventId) {
      const ev = state.calendars.get(calendarId)?.events.get(eventId);
      return ev ? toEvent(calendarId, ev) : null;
    },
    async patchEvent(calendarId, eventId, patch) {
      const c = calendarOf(calendarId);
      const ev = c.events.get(eventId) ?? {
        summary: "", description: null, start: "", end: "", timeZone: "Asia/Tokyo", recurrence: [], attendees: [],
        id: eventId, meetUrl: `https://meet.google.com/mock-${eventId}`,
      };
      const merged = { ...ev, ...patch, attendees: (patch.attendees ?? ev.attendees).map((a) => ({ ...a })) };
      c.events.set(eventId, merged);
      return toEvent(calendarId, merged);
    },
    async deleteEvent(calendarId, eventId) {
      state.calendars.get(calendarId)?.events.delete(eventId);
    },
  };
}
