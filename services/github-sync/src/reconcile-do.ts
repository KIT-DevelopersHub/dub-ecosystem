// github-sync reconcile Durable Object: a self-rescheduling alarm loop that REPLACES the
// Cron Trigger on the free plan. A DO alarm does NOT consume a slot in the Workers Free
// plan's 5-cron ACCOUNT cap — that cap is already full of five business crons, so adding
// github-sync's reconcile as a 6th cron would be rejected. The alarm runs the reconcile
// pass every 6h without displacing any of the five. Same proven pattern as freeq-drain's
// FreeqDrainDO.
//
// Lifecycle: POST /internal/reconcile/kick (see app.ts) bootstraps the loop once by calling
// this DO's fetch -> ensureAlarm(). Thereafter alarm() reschedules itself every tick, so the
// loop is self-sustaining with no external ticker. SQLite-backed DO (see wrangler.free.toml
// new_sqlite_classes) is available on the free plan; alarms are supported on SQLite-backed DOs.
import type { DurableObjectState } from "@cloudflare/workers-types";
import { runReconcileCron } from "./reconcile";
import type { Env } from "./env";

// 6 hours — matches the retired `crons = ["0 */6 * * *"]` cadence.
export const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class GithubReconcileDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  // Bootstrap entrypoint (idempotent). A kick while the loop already runs is a no-op: an
  // alarm is only set when none is pending, so repeated kicks never shift the schedule.
  async fetch(_req: Request): Promise<Response> {
    const alarmAt = await this.ensureAlarm();
    return new Response(JSON.stringify({ ok: true, service: "github-reconcile-do", alarmAt }), {
      headers: { "content-type": "application/json" },
    });
  }

  /** Schedule the first alarm if none is pending. Returns the pending alarm time. */
  async ensureAlarm(): Promise<number> {
    const existing = await this.state.storage.getAlarm();
    if (existing !== null) return existing;
    const at = Date.now() + RECONCILE_INTERVAL_MS;
    await this.state.storage.setAlarm(at);
    return at;
  }

  // Fired by the runtime at each scheduled time. Reschedule FIRST so the loop stays alive
  // even if the reconcile body throws; THEN run the reconcile pass.
  async alarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);
    await runReconcileCron(this.env);
  }
}
