// Google Meet REST v2 conference records (人事 > 出席) — the ONLY place raw conferenceRecords /
// participants / participantSessions calls live. Needs meetings.space.readonly on the shared
// account; conferenceRecords.list only returns conferences the account organised (the shared
// account owns every Dub meeting's Meet, since it creates the Calendar events).
// Same transport rules as calendar-client.ts: non-2xx -> mapGoogleError, 401 -> one forced refresh.
import { errors } from "@dub/errors";
import { retryFetch } from "@dub/http";
import { mapGoogleError } from "../drive-client";
import type { TokenProvider } from "./token";

const MEET_BASE = "https://meet.googleapis.com/v2";
const PAGE_SIZE = "100";

export interface MeetConference {
  /** "conferenceRecords/{id}" */
  name: string;
  startTime: string;
  endTime: string | null;
}

export interface MeetParticipantRecord {
  /** "conferenceRecords/{id}/participants/{id}" */
  name: string;
  kind: "signed_in" | "anonymous" | "phone";
  /** {id} of signedinUser.user ("users/{id}"); null for anonymous / phone. */
  googleUserId: string | null;
  displayName: string;
  earliestStartTime: string;
  latestEndTime: string | null;
}

export interface MeetSession {
  startTime: string;
  endTime: string | null;
}

export interface MeetRecordsClient {
  /** Conferences of the Meet with this meeting code that started within [fromIso, toIso]. */
  listConferences(meetingCode: string, fromIso: string, toIso: string): Promise<MeetConference[]>;
  listParticipants(conference: string): Promise<MeetParticipantRecord[]>;
  listSessions(participant: string): Promise<MeetSession[]>;
}

interface RawParticipant {
  name?: string;
  earliestStartTime?: string;
  latestEndTime?: string;
  signedinUser?: { user?: string; displayName?: string };
  anonymousUser?: { displayName?: string };
  phoneUser?: { displayName?: string };
}

export function mapParticipant(p: RawParticipant): MeetParticipantRecord | null {
  if (!p.name || !p.earliestStartTime) return null;
  const base = { name: p.name, earliestStartTime: p.earliestStartTime, latestEndTime: p.latestEndTime ?? null };
  if (p.signedinUser) {
    const id = /^users\/(.+)$/.exec(p.signedinUser.user ?? "")?.[1] ?? null;
    return { ...base, kind: "signed_in", googleUserId: id, displayName: p.signedinUser.displayName ?? "（名前なし）" };
  }
  if (p.phoneUser) return { ...base, kind: "phone", googleUserId: null, displayName: p.phoneUser.displayName ?? "電話" };
  return { ...base, kind: "anonymous", googleUserId: null, displayName: p.anonymousUser?.displayName ?? "ゲスト" };
}

/** RFC 3339 filter string value (Meet wants quoted timestamps). */
const q = (v: string) => `"${v.replace(/"/g, "")}"`;

export function createGoogleMeetRecordsClient(deps: { token: TokenProvider; fetchImpl?: typeof fetch }): MeetRecordsClient {
  const doFetch = deps.fetchImpl ?? ((input: string | URL | Request, init?: RequestInit) => retryFetch(input, init));

  async function get<T>(url: URL): Promise<T> {
    const attempt = async (forceRefresh: boolean) => {
      const token = await deps.token.getAccessToken(forceRefresh ? { forceRefresh: true } : undefined);
      try {
        return await doFetch(url.toString(), { method: "GET", headers: { authorization: `Bearer ${token}` } });
      } catch (cause) {
        const aborted = cause instanceof Error && cause.name === "AbortError";
        throw aborted ? errors.upstreamTimeout("google", cause) : errors.upstreamUnavailable("google", cause);
      }
    };
    let res = await attempt(false);
    if (res.status === 401) res = await attempt(true);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw mapGoogleError(res.status, body, { api: "meet", operation: "conferenceRecords" });
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  /** Every page of a list call (each page = one call against the caller's budget). */
  async function all<R, T>(path: string, params: Record<string, string>, key: string, map: (r: R) => T | null): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${MEET_BASE}/${path}`);
      url.searchParams.set("pageSize", PAGE_SIZE);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const json = await get<Record<string, unknown> & { nextPageToken?: string }>(url);
      for (const r of (json[key] as R[] | undefined) ?? []) {
        const m = map(r);
        if (m) out.push(m);
      }
      pageToken = json.nextPageToken;
    } while (pageToken);
    return out;
  }

  return {
    listConferences: (code, fromIso, toIso) =>
      all<{ name?: string; startTime?: string; endTime?: string }, MeetConference>(
        "conferenceRecords",
        { filter: `space.meeting_code = ${q(code)} AND start_time >= ${q(fromIso)} AND start_time <= ${q(toIso)}` },
        "conferenceRecords",
        (r) => (r.name && r.startTime ? { name: r.name, startTime: r.startTime, endTime: r.endTime ?? null } : null),
      ),
    listParticipants: (conference) => all<RawParticipant, MeetParticipantRecord>(`${conference}/participants`, {}, "participants", mapParticipant),
    listSessions: (participant) =>
      all<{ startTime?: string; endTime?: string }, MeetSession>(`${participant}/participantSessions`, {}, "participantSessions", (r) =>
        r.startTime ? { startTime: r.startTime, endTime: r.endTime ?? null } : null,
      ),
  };
}

/** No Google behind it (mock / nothing connected): every Meet reads as "no conference". */
export function createEmptyMeetRecordsClient(): MeetRecordsClient {
  return { listConferences: async () => [], listParticipants: async () => [], listSessions: async () => [] };
}
