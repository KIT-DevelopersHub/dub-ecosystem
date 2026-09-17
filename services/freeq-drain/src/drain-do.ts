// freeq-drain Durable Object: a self-rescheduling alarm loop that REPLACES the Cron
// Trigger. A DO alarm does NOT consume a slot in the Workers Free plan's 5-cron ACCOUNT
// cap — that cap was already full with five business crons — so the aggregated freeq drain
// runs every 5 minutes without displacing any of them.
//
// Lifecycle: POST /internal/drain/kick (see app.ts) bootstraps the loop once by calling
// this DO's fetch -> ensureAlarm(). Thereafter alarm() reschedules itself every tick, so
// the loop is self-sustaining for the Worker's lifetime with no external ticker. The DO is
// SQLite-backed (see wrangler.toml new_sqlite_classes) which is available on the free plan;
// alarms are supported on SQLite-backed DOs.
import type { DurableObjectState } from "@cloudflare/workers-types";
import { consoleSink } from "@dub/observability";
import { drainAll } from "./drain-all";
import type { Env } from "./env";

// 60 seconds — the drain safety-net cadence. A DO alarm does NOT count against the
// Workers Free plan's 5-cron ACCOUNT cap, so this can run far more often than the
// retired `crons = ["*/5 * * * *"]` without displacing any business cron. It was
// lowered from 5min to 60s so any freeq outbox row (audit, deferred consumers, and any
// evt.notification whose producer-side immediate direct-deliver was best-effort-dropped)
// is delivered within a minute worst-case instead of up to five. The primary latency fix
// for chat DM/@mention notifications is the producer-side immediate direct delivery
// (chat-service -> notification POST /internal/events-async, idempotent on envelope.id);
// this alarm is the durable fallback that guarantees eventual delivery.
export const DRAIN_INTERVAL_MS = 60 * 1000;

export class FreeqDrainDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  // Bootstrap entrypoint (idempotent). A kick while the loop already runs is a no-op: an
  // alarm is only set when none is pending, so repeated kicks never shift the schedule.
  async fetch(_req: Request): Promise<Response> {
    const alarmAt = await this.ensureAlarm();
    return new Response(JSON.stringify({ ok: true, service: "freeq-drain-do", alarmAt }), {
      headers: { "content-type": "application/json" },
    });
  }

  /** Schedule the first alarm if none is pending. Returns the pending alarm time. */
  async ensureAlarm(): Promise<number> {
    const existing = await this.state.storage.getAlarm();
    if (existing !== null) return existing;
    const at = Date.now() + DRAIN_INTERVAL_MS;
    await this.state.storage.setAlarm(at);
    return at;
  }

  // Fired by the runtime at each scheduled time. Reschedule FIRST so the loop stays alive
  // even in the (defensive) event the drain body throws; THEN run the aggregated drain —
  // which itself never throws (drainAll captures every per-DB error in its result).
  async alarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + DRAIN_INTERVAL_MS);
    const results = await drainAll(this.env);
    consoleSink({ level: "info", message: "freeq aggregated drain (DO alarm)", service: "freeq-drain", fields: { ...results } });
  }
}
