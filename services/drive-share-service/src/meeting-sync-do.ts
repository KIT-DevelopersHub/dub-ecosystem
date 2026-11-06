// MeetingSyncDO — the hourly カレンダー > ミーティング invitation sync, driven by a SQLite-backed
// Durable Object ALARM instead of a Cron Trigger (the Workers Free plan's 5-cron account cap is
// full; a DO alarm does not count against it). Same reconcile as POST /meetings/sync, run as the
// system actor (identity /internal/users and member-service internal routes need no user).
//
// Every meeting write and /meetings/sync kicks it (POST /kick { soonMs }). ensureAlarm reschedules
// when no alarm is pending OR the pending one is already in the past — an overdue alarm must never
// be left as-is (usage-meter got stuck forever exactly that way).
//
// It also holds the calendar sync's state (meeting-sync-state.ts): a Calendar usage limit pauses the
// sync, not the loop — the run counts as finished, so nothing re-runs it, and the Meet ingest and the
// Drive共有 follow (other APIs, other quotas) keep their hourly turn. During a pause a kick only
// keeps the alarm alive: pulling it earlier would run those phases for nothing.
import type { DurableObjectState } from "@cloudflare/workers-types";
import { newRequestId } from "@dub/http";
import { createStorageSyncState, type MeetingSyncState } from "./meeting-sync-state";
import { buildMeetingsService, runScheduledMeetIngest, runScheduledRoleShareSync } from "./meetings-wiring";
import type { RoleSyncResume } from "./role-grants-service";
import type { Env } from "./env";

const HOUR_MS = 60 * 60 * 1000;
/** A run cut short by the Google call budget continues this soon. */
const CONTINUE_MS = 2 * 60 * 1000;
/** Google calls per alarm run (Workers subrequest cap leaves room for D1 / identity / member). */
const ALARM_GOOGLE_BUDGET = 35;
/** An alarm has no request deadline; still bound one run well under the 15 min alarm limit. */
const ALARM_TIME_LIMIT_MS = 5 * 60 * 1000;

/** Next alarm time given the pending one: schedule when none / overdue, pull earlier for `soonMs`. */
/** Storage key: the next alarm runs the Meet attendance ingest instead of the invitation sync. Each
 *  phase gets its own invocation, so each has the whole subrequest allowance. */
const PHASE_KEY = "phase";
const INGEST_AFTER_SYNC_MS = 60 * 1000;
/** Drive共有 follows role membership in a third phase of the same hourly loop. */
const ROLE_SHARES_AFTER_INGEST_MS = 60 * 1000;
/** Storage key: where an unfinished Drive共有 follow continues. */
const ROLE_RESUME_KEY = "roleShareResume";

export function nextAlarmAt(pending: number | null, now: number, soonMs?: number): number | null {
  const target = now + (soonMs ?? HOUR_MS);
  if (pending === null || pending <= now) return target;
  if (soonMs !== undefined && pending > target) return target;
  return null; // keep the pending one
}

export class MeetingSyncDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private readonly syncState: MeetingSyncState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.syncState = createStorageSyncState(state.storage);
  }

  async fetch(req: Request): Promise<Response> {
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    const { pathname } = new URL(req.url);
    if (pathname === "/sync-state") return json(await this.syncState.load());
    if (pathname === "/sync-state/pause") {
      const { now, until } = (await req.json()) as { now: number; until: number };
      return json(await this.syncState.pause(now, until));
    }
    let soonMs: number | undefined;
    if (req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { soonMs?: unknown } | null;
      if (typeof body?.soonMs === "number" && body.soonMs >= 0) soonMs = body.soonMs;
    }
    if (soonMs !== undefined) {
      const { pausedUntil } = await this.syncState.load();
      if (pausedUntil !== null && pausedUntil > Date.now()) soonMs = undefined;
    }
    const alarmAt = await this.ensureAlarm(soonMs);
    return json({ ok: true, alarmAt });
  }

  async ensureAlarm(soonMs?: number): Promise<number> {
    const pending = await this.state.storage.getAlarm();
    const at = nextAlarmAt(pending, Date.now(), soonMs);
    if (at === null) return pending as number;
    await this.state.storage.setAlarm(at);
    return at;
  }

  async alarm(): Promise<void> {
    // Reschedule FIRST so the loop survives a throwing run.
    await this.state.storage.setAlarm(Date.now() + HOUR_MS);
    const phase = await this.state.storage.get<string>(PHASE_KEY);
    if (phase === "ingest") {
      await this.ingest();
      return;
    }
    if (phase === "roleShares") {
      await this.roleShares();
      return;
    }
    // The ingest follows each sync a minute later.
    await this.state.storage.put(PHASE_KEY, "ingest");
    await this.state.storage.setAlarm(Date.now() + INGEST_AFTER_SYNC_MS);
    try {
      const svc = await buildMeetingsService(this.env, { requestId: newRequestId() }, { system: true, googleBudget: ALARM_GOOGLE_BUDGET, syncTimeLimitMs: ALARM_TIME_LIMIT_MS, syncState: this.syncState });
      const r = await svc.sync({ system: true });
      if (!r.complete) {
        // Finish the sync first; the ingest waits for its turn.
        await this.state.storage.put(PHASE_KEY, "sync");
        await this.state.storage.setAlarm(Date.now() + CONTINUE_MS);
      }
      console.log(JSON.stringify({ service: "drive-share-service", event: "meeting_sync_alarm", meetings: r.meetings, added: r.invitedAdded, removed: r.invitedRemoved, complete: r.complete, ...(r.quotaPausedUntil ? { quotaPausedUntil: new Date(r.quotaPausedUntil).toISOString() } : {}) }));
    } catch (err) {
      console.warn(JSON.stringify({ service: "drive-share-service", event: "meeting_sync_alarm_failed", message: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** 人事 > 出席: read Meet participant records of ended 定例 occurrences (catch-up within retention). */
  private async ingest(): Promise<void> {
    try {
      const r = await runScheduledMeetIngest(this.env, { budget: ALARM_GOOGLE_BUDGET, deadline: Date.now() + ALARM_TIME_LIMIT_MS });
      if (r && !r.complete) {
        await this.state.storage.setAlarm(Date.now() + CONTINUE_MS); // still phase "ingest"
        return;
      }
      console.log(JSON.stringify({ service: "drive-share-service", event: "meet_ingest_alarm", skipped: r === null, occurrences: r?.occurrences ?? 0, participants: r?.participants ?? 0 }));
    } catch (err) {
      console.warn(JSON.stringify({ service: "drive-share-service", event: "meet_ingest_alarm_failed", message: err instanceof Error ? err.message : String(err) }));
    }
    await this.state.storage.put(PHASE_KEY, "roleShares");
    await this.state.storage.setAlarm(Date.now() + ROLE_SHARES_AFTER_INGEST_MS);
  }

  /** Drive共有: share files with members who joined a role. Each continuation resumes past the
   *  members already tried, so one that Drive keeps refusing cannot hold the loop here. */
  private async roleShares(): Promise<void> {
    try {
      const resume = await this.state.storage.get<RoleSyncResume>(ROLE_RESUME_KEY);
      const r = await runScheduledRoleShareSync(this.env, { budgetMs: ALARM_TIME_LIMIT_MS, maxWrites: ALARM_GOOGLE_BUDGET, ...(resume ? { resume } : {}) });
      console.log(JSON.stringify({ service: "drive-share-service", event: "role_share_sync_alarm", skipped: r === null, grants: r?.grants ?? 0, touched: r?.touched ?? 0, shared: r?.shared ?? 0, refused: r?.skipped ?? 0, complete: !r?.resume }));
      if (r?.resume) {
        await this.state.storage.put(ROLE_RESUME_KEY, r.resume);
        await this.state.storage.setAlarm(Date.now() + CONTINUE_MS); // still phase "roleShares"
        return;
      }
    } catch (err) {
      console.warn(JSON.stringify({ service: "drive-share-service", event: "role_share_sync_alarm_failed", message: err instanceof Error ? err.message : String(err) }));
    }
    await this.state.storage.delete(ROLE_RESUME_KEY);
    await this.state.storage.put(PHASE_KEY, "sync");
  }
}
