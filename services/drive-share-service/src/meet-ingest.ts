// 人事 > 出席: read Google Meet participant records of 定例 occurrences into D1.
//
// For each 定例 occurrence that ended (≥ SETTLE_MS ago) within Google's retention window, find the
// conference(s) of the meeting's Meet that started around it (conferenceRecords.list, filtered by
// meeting code + start time), list their participants and each participant's sessions, merge them
// per person (one Google account = one row, even across a restarted call) and replace the
// occurrence's rows — so a re-run is idempotent. The ingest ledger makes runs cheap: an occurrence
// is re-read only while its data may still change (shortly after the end), after an error, or when
// forced (人事's 「今すぐ取り込む」).
//
// Workers allow few subrequests per invocation, so Google calls run against a budget. When the
// budget runs low a participant's sessions are skipped and its duration is first join → last leave
// (`approx`); when it runs out the run stops with complete=false and the scheduled job (the
// MeetingSyncDO alarm) continues a couple of minutes later.
import { meeting } from "@dub/types";
import type { AttendanceStore, IngestRow, ParticipantRow } from "./attendance-store";
import { meetingCodeOf } from "./google/calendar-client";
import type { MeetParticipantRecord, MeetRecordsClient, MeetSession } from "./google/meet-records-client";
import { jstDate } from "./meeting-rules";
import type { MeetingRow, MeetingStore } from "./meetings-store";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Google keeps conference records ~30 days; stay inside it. */
export const RETENTION_DAYS = 29;
/** Read an occurrence this long after its scheduled end (late leavers settle). */
const SETTLE_MS = 10 * MINUTE;
/** A "done" occurrence is re-read until this long after its end (people who stayed late). */
const REFRESH_UNTIL_MS = 3 * 60 * MINUTE;
/** "no conference" is retried until this long after the end (records can appear late). */
const NO_CONFERENCE_UNTIL_MS = 12 * 60 * MINUTE;
const MAX_ATTEMPTS = 12;
/** Conferences that started this early before the occurrence still count (early start). */
const EARLY_START_MS = 60 * MINUTE;

class BudgetExhausted extends Error {}

export interface IngestDeps {
  meetings: MeetingStore;
  store: AttendanceStore;
  client: MeetRecordsClient;
  orgId: string;
  now: () => string;
}

export interface IngestOptions {
  /** Re-read occurrences already read (manual run). */
  force?: boolean;
  /** JST dates; clipped to the retention window. */
  from?: string;
  to?: string;
  /** Max Google calls this run. */
  budget: number;
  /** Epoch ms deadline. */
  deadline?: number;
}

export interface IngestResult {
  occurrences: number;
  participants: number;
  complete: boolean;
}

interface Candidate {
  m: MeetingRow;
  code: string;
  date: string;
  startMs: number;
  endMs: number;
}

/** Sum of session lengths (overlaps merged), open sessions ending at `openEnd`. */
export function sessionSeconds(sessions: readonly MeetSession[], openEnd: number): number {
  const spans = sessions
    .map((s) => [Date.parse(s.startTime), s.endTime ? Date.parse(s.endTime) : openEnd] as const)
    .filter(([a, b]) => !Number.isNaN(a) && !Number.isNaN(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curA = -1;
  let curB = -1;
  for (const [a, b] of spans) {
    if (a > curB) {
      if (curB > curA) total += curB - curA;
      curA = a;
      curB = b;
    } else if (b > curB) curB = b;
  }
  if (curB > curA) total += curB - curA;
  return Math.round(total / 1000);
}

/** The occurrences to read now, oldest first (they expire first). */
export async function ingestCandidates(deps: Pick<IngestDeps, "meetings" | "store" | "orgId">, nowMs: number, opts: Pick<IngestOptions, "force" | "from" | "to">): Promise<Candidate[]> {
  const regular = await deps.store.listRegularIds(deps.orgId);
  if (regular.size === 0) return [];
  const oldest = jstDate(new Date(nowMs - RETENTION_DAYS * DAY).toISOString());
  const today = jstDate(new Date(nowMs).toISOString());
  const from = opts.from && opts.from > oldest ? opts.from : oldest;
  const to = opts.to && opts.to < today ? opts.to : today;
  if (from > to) return [];
  const ledger = new Map((await deps.store.listIngests(deps.orgId, from, to)).map((i) => [`${i.meetingId}|${i.occurrenceDate}`, i]));
  const out: Candidate[] = [];
  for (const m of await deps.meetings.listMeetings(deps.orgId)) {
    if (!regular.has(m.id) || !m.meetUrl) continue;
    const code = meetingCodeOf(m.meetUrl);
    if (!code) continue;
    for (const o of meeting.occurrenceStarts(m, from, to)) {
      const startMs = Date.parse(o.startsAt);
      const endMs = startMs + m.durationMinutes * MINUTE;
      if (endMs + SETTLE_MS > nowMs) continue;
      const done = ledger.get(`${m.id}|${o.date}`);
      if (!opts.force && done && !needsRead(done, endMs)) continue;
      out.push({ m, code, date: o.date, startMs, endMs });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

function needsRead(i: IngestRow, endMs: number): boolean {
  const at = Date.parse(i.ingestedAt);
  if (i.status === "done") return at < endMs + REFRESH_UNTIL_MS;
  if (i.status === "no_conference") return at < endMs + NO_CONFERENCE_UNTIL_MS;
  return i.attempts < MAX_ATTEMPTS;
}

export async function runMeetIngest(deps: IngestDeps, opts: IngestOptions): Promise<IngestResult> {
  const nowIso = deps.now();
  const nowMs = Date.parse(nowIso);
  let left = opts.budget;
  const spend = () => {
    if (left <= 0 || (opts.deadline !== undefined && Date.now() > opts.deadline)) throw new BudgetExhausted();
    left--;
  };
  const result: IngestResult = { occurrences: 0, participants: 0, complete: true };
  const candidates = await ingestCandidates(deps, nowMs, opts);

  for (const c of candidates) {
    const prev = await deps.store.getIngest(c.m.id, c.date);
    try {
      spend();
      const conferences = await deps.client.listConferences(
        c.code,
        new Date(c.startMs - EARLY_START_MS).toISOString(),
        new Date(c.endMs).toISOString(),
      );
      const people = new Map<string, ParticipantRow>();
      for (const conf of conferences) {
        spend();
        const confEnd = conf.endTime ? Date.parse(conf.endTime) : nowMs;
        for (const p of await deps.client.listParticipants(conf.name)) {
          let seconds: number;
          let approx = false;
          // Keep one call in reserve per remaining conference; below that, fall back to the span.
          if (left > 1) {
            spend();
            seconds = sessionSeconds(await deps.client.listSessions(p.name), confEnd);
          } else {
            approx = true;
            seconds = spanSeconds(p, confEnd);
          }
          merge(people, c, p, seconds, approx, nowIso, deps.orgId);
        }
      }
      await deps.store.replaceParticipants(deps.orgId, c.m.id, c.date, [...people.values()]);
      await deps.store.putIngest({
        meetingId: c.m.id,
        occurrenceDate: c.date,
        orgId: deps.orgId,
        status: conferences.length > 0 ? "done" : "no_conference",
        conferences: conferences.length,
        participants: people.size,
        attempts: (prev?.attempts ?? 0) + 1,
        lastError: null,
        ingestedAt: nowIso,
      });
      result.occurrences++;
      result.participants += people.size;
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        result.complete = false;
        break;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.warn(JSON.stringify({ service: "drive-share-service", event: "meet_ingest_failed", meetingId: c.m.id, date: c.date, message }));
      await deps.store.putIngest({
        meetingId: c.m.id,
        occurrenceDate: c.date,
        orgId: deps.orgId,
        status: "error",
        conferences: prev?.conferences ?? 0,
        participants: prev?.participants ?? 0,
        attempts: (prev?.attempts ?? 0) + 1,
        lastError: message.slice(0, 500),
        ingestedAt: nowIso,
      });
    }
  }
  return result;
}

function spanSeconds(p: MeetParticipantRecord, confEnd: number): number {
  const a = Date.parse(p.earliestStartTime);
  const b = p.latestEndTime ? Date.parse(p.latestEndTime) : confEnd;
  return Number.isNaN(a) || Number.isNaN(b) || b <= a ? 0 : Math.round((b - a) / 1000);
}

/** One row per person across conferences: signed-in users by Google account id, others per participant. */
function merge(
  people: Map<string, ParticipantRow>,
  c: Candidate,
  p: MeetParticipantRecord,
  seconds: number,
  approx: boolean,
  nowIso: string,
  orgId: string,
): void {
  const key = p.kind === "signed_in" && p.googleUserId ? `u:${p.googleUserId}` : p.name;
  const cur = people.get(key);
  if (!cur) {
    people.set(key, {
      meetingId: c.m.id,
      occurrenceDate: c.date,
      participantKey: key,
      orgId,
      kind: p.kind,
      googleUserId: p.googleUserId,
      displayName: p.displayName,
      firstJoin: new Date(Date.parse(p.earliestStartTime)).toISOString(),
      lastLeave: p.latestEndTime ? new Date(Date.parse(p.latestEndTime)).toISOString() : null,
      durationSeconds: seconds,
      approx,
      ingestedAt: nowIso,
    });
    return;
  }
  const first = new Date(Date.parse(p.earliestStartTime)).toISOString();
  if (first < cur.firstJoin) cur.firstJoin = first;
  if (cur.lastLeave !== null) cur.lastLeave = p.latestEndTime === null ? null : [cur.lastLeave, new Date(Date.parse(p.latestEndTime)).toISOString()].sort()[1]!;
  cur.durationSeconds += seconds;
  cur.approx = cur.approx || approx;
}
