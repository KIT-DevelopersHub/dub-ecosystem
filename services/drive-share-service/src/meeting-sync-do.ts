// MeetingSyncDO — the hourly カレンダー > ミーティング invitation sync, driven by a SQLite-backed
// Durable Object ALARM instead of a Cron Trigger (the Workers Free plan's 5-cron account cap is
// full; a DO alarm does not count against it). Same reconcile as POST /meetings/sync, run as the
// system actor (identity /internal/users and member-service internal routes need no user).
//
// Every meeting write and /meetings/sync kicks it (POST /kick { soonMs }). ensureAlarm reschedules
// when no alarm is pending OR the pending one is already in the past — an overdue alarm must never
// be left as-is (usage-meter got stuck forever exactly that way).
import type { DurableObjectState } from "@cloudflare/workers-types";
import { newRequestId } from "@dub/http";
import { buildMeetingsService } from "./meetings-wiring";
import type { Env } from "./env";

const HOUR_MS = 60 * 60 * 1000;
/** A run cut short by the Google call budget continues this soon. */
const CONTINUE_MS = 2 * 60 * 1000;
/** Google calls per alarm run (Workers subrequest cap leaves room for D1 / identity / member). */
const ALARM_GOOGLE_BUDGET = 35;
/** An alarm has no request deadline; still bound one run well under the 15 min alarm limit. */
const ALARM_TIME_LIMIT_MS = 5 * 60 * 1000;

/** Next alarm time given the pending one: schedule when none / overdue, pull earlier for `soonMs`. */
export function nextAlarmAt(pending: number | null, now: number, soonMs?: number): number | null {
  const target = now + (soonMs ?? HOUR_MS);
  if (pending === null || pending <= now) return target;
  if (soonMs !== undefined && pending > target) return target;
  return null; // keep the pending one
}

export class MeetingSyncDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    let soonMs: number | undefined;
    if (req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { soonMs?: unknown } | null;
      if (typeof body?.soonMs === "number" && body.soonMs >= 0) soonMs = body.soonMs;
    }
    const alarmAt = await this.ensureAlarm(soonMs);
    return new Response(JSON.stringify({ ok: true, alarmAt }), { headers: { "content-type": "application/json" } });
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
    try {
      const svc = await buildMeetingsService(this.env, { requestId: newRequestId() }, { system: true, googleBudget: ALARM_GOOGLE_BUDGET, syncTimeLimitMs: ALARM_TIME_LIMIT_MS });
      const r = await svc.sync({ system: true });
      if (!r.complete) await this.state.storage.setAlarm(Date.now() + CONTINUE_MS);
      console.log(JSON.stringify({ service: "drive-share-service", event: "meeting_sync_alarm", meetings: r.meetings, added: r.invitedAdded, removed: r.invitedRemoved, complete: r.complete }));
    } catch (err) {
      console.warn(JSON.stringify({ service: "drive-share-service", event: "meeting_sync_alarm_failed", message: err instanceof Error ? err.message : String(err) }));
    }
  }
}
