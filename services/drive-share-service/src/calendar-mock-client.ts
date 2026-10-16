// In-memory MOCK Calendar client, chosen exactly when the Drive client is the mock (no account
// connected, or DRIVESHARE_MOCK forces it) so カレンダー > ミーティング builds, runs and E2Es at $0.
// Mirrors the real client's observable behaviour (Meet link on insert, idempotent deletes,
// deleted events read back as null, a client-chosen id makes insert idempotent).
import { EventIdTaken, type CalendarAclRule, type CalendarClient, type CalendarEvent, type CalendarEventInput } from "./google/calendar-client";

interface MockCalendar {
  summary: string;
  acl: CalendarAclRule[];
  events: Map<string, CalendarEventInput & { id: string; meetUrl: string }>;
}

export interface MockCalendarState {
  calendars: Map<string, MockCalendar>;
  /** "calendarId eventId" of every deleted event (reads back as gone, id stays taken). */
  deleted: Set<string>;
  /** Meet links made open to anyone (openMeet). */
  openMeets: Set<string>;
  seq: number;
}

export function createMockCalendarState(): MockCalendarState {
  return { calendars: new Map(), deleted: new Set(), openMeets: new Set(), seq: 0 };
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
  const key = (calendarId: string, eventId: string) => `${calendarId} ${eventId}`;
  // A materialised event (start "") reports no fields, so reconcile never pulls blanks into D1.
  const toEvent = (calendarId: string, e: CalendarEventInput & { id: string; meetUrl: string }): CalendarEvent => ({
    id: e.id,
    htmlLink: `https://calendar.google.com/calendar/event?eid=${encodeURIComponent(`${e.id} ${calendarId}`)}`,
    meetUrl: e.meetUrl,
    attendees: e.attendees.map((a) => ({ ...a })),
    ...(e.start ? { summary: e.summary, description: e.description, start: e.start, end: e.end, recurrence: [...e.recurrence] } : {}),
  });
  const blank = (eventId: string) => ({
    summary: "", description: null, start: "", end: "", timeZone: "Asia/Tokyo", recurrence: [], attendees: [],
    id: eventId, meetUrl: `https://meet.google.com/mock-${eventId}`,
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
      if (input.id) {
        const existing = c.events.get(input.id);
        if (existing) return toEvent(calendarId, existing);
        if (state.deleted.has(key(calendarId, input.id))) throw new EventIdTaken(input.id);
      }
      const id = input.id ?? next("evt");
      const ev = { ...input, attendees: input.attendees.map((a) => ({ ...a })), id, meetUrl: `https://meet.google.com/mock-${id}` };
      c.events.set(id, ev);
      return toEvent(calendarId, ev);
    },
    async getEvent(calendarId, eventId) {
      if (state.deleted.has(key(calendarId, eventId))) return null;
      // An event this isolate never saw is not "deleted in Google": materialise it.
      const c = calendarOf(calendarId);
      const ev = c.events.get(eventId) ?? blank(eventId);
      c.events.set(eventId, ev);
      return toEvent(calendarId, ev);
    },
    async patchEvent(calendarId, eventId, patch) {
      const c = calendarOf(calendarId);
      const ev = c.events.get(eventId) ?? blank(eventId);
      const merged = { ...ev, ...patch, attendees: (patch.attendees ?? ev.attendees).map((a) => ({ ...a })) };
      c.events.set(eventId, merged);
      return toEvent(calendarId, merged);
    },
    async deleteEvent(calendarId, eventId) {
      state.calendars.get(calendarId)?.events.delete(eventId);
      state.deleted.add(key(calendarId, eventId));
    },
    async openMeet(meetUrl) {
      state.openMeets.add(meetUrl);
      return true;
    },
  };
}
