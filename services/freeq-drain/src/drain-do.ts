// freeq-drain Durable Object: a self-rescheduling alarm loop that REPLACES the Cron
// Trigger. A DO alarm does NOT consume a slot in the Workers Free plan's 5-cron ACCOUNT
// cap — that cap was already full with five business crons — so the aggregated freeq drain
// runs every 5 minutes without displacing any of them.
//
// Lifecycle: POST /internal/drain/kick (see app.ts) bootstraps the loop once by calling
// this DO's fetch -> ensureAlarm(). Thereafter alarm() reschedules itself every tick, so
// the loop is self-sustaining. BACKSTOP: the loop alone is a single point of failure (an
// alarm that is dropped is never re-armed — the 2026-09-21 two-month stall), so the
// mail-gateway */5 business cron also calls the kick every tick (no extra cron slot);
// ensureAlarm re-arms a missing or wedged alarm and is a no-op otherwise. The DO is
// SQLite-backed (see wrangler.toml new_sqlite_classes) which is available on the free plan;
// alarms are supported on SQLite-backed DOs.
import type { DurableObjectState } from "@cloudflare/workers-types";
import { consoleSink } from "@dub/observability";
import { drainAll, pruneAll, type PruneAllResult } from "./drain-all";
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

// Retention runs far less often than the drain: delivery is the hot path, pruning is
// housekeeping. At most once every 6h keeps prune write traffic negligible while still
// bounding table growth. The last-prune timestamp is persisted in DO storage so the
// cadence holds across ticks (the drain fires every 60s).
export const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const LAST_PRUNE_KEY = "freeq:lastPruneAt";

// Self-healing thresholds. An alarm that is still "pending" this long after its due time is
// considered wedged and re-armed by ensureAlarm (called from every kick — see the mail-gateway
// cron backstop — and at the end of every alarm).
export const OVERDUE_ALARM_MS = 5 * 60 * 1000;
export const LAST_TICK_KEY = "freeq:lastTickAt";

export class FreeqDrainDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  // Bootstrap / watchdog entrypoint (idempotent). Reached via POST /internal/drain/kick,
  // which the mail-gateway */5 cron calls as a BACKSTOP: if the alarm chain ever dies (as it
  // did on 2026-09-21 14:45Z, with nothing able to re-arm it for two months) the next cron
  // tick re-arms it. A kick while the loop is healthy is a no-op (the schedule never shifts).
  async fetch(_req: Request): Promise<Response> {
    const alarmAt = await this.ensureAlarm();
    const lastTickAt = (await this.state.storage.get<number>(LAST_TICK_KEY)) ?? null;
    return new Response(JSON.stringify({ ok: true, service: "freeq-drain-do", alarmAt, lastTickAt }), {
      headers: { "content-type": "application/json" },
    });
  }

  /**
   * Make sure a live alarm is pending. Arms one when none exists; RE-arms one that is
   * overdue by more than OVERDUE_ALARM_MS (a wedged alarm). Returns the pending alarm time.
   */
  async ensureAlarm(): Promise<number> {
    const now = Date.now();
    const existing = await this.state.storage.getAlarm();
    if (existing !== null && existing >= now - OVERDUE_ALARM_MS) return existing;
    const at = existing === null ? now + DRAIN_INTERVAL_MS : now + 1000; // wedged -> fire ASAP
    await this.state.storage.setAlarm(at);
    return at;
  }

  // Fired by the runtime at each scheduled time. MUST NEVER THROW: a throwing alarm() is
  // retried by the runtime a bounded number of times and then DROPPED, which silently ends a
  // self-rescheduling loop for good. So: reschedule first, run the body inside try/catch,
  // and re-verify a pending alarm in `finally` (covers a setAlarm that failed up front).
  async alarm(): Promise<void> {
    try {
      await this.state.storage.setAlarm(Date.now() + DRAIN_INTERVAL_MS);
    } catch (err) {
      this.logError("freeq-drain: setAlarm failed before drain", err);
    }
    try {
      const results = await drainAll(this.env);
      const prune = await this.maybePrune();
      await this.state.storage.put(LAST_TICK_KEY, Date.now());
      consoleSink({
        level: "info",
        message: "freeq aggregated drain (DO alarm)",
        service: "freeq-drain",
        fields: { ...results, ...(prune ? { prune } : {}) },
      });
    } catch (err) {
      this.logError("freeq-drain: alarm body failed (loop kept alive)", err);
    } finally {
      try {
        if ((await this.state.storage.getAlarm()) === null) {
          await this.state.storage.setAlarm(Date.now() + DRAIN_INTERVAL_MS);
        }
      } catch (err) {
        this.logError("freeq-drain: could not re-arm alarm in finally (cron backstop will)", err);
      }
    }
  }

  private logError(message: string, err: unknown): void {
    try {
      consoleSink({
        level: "error",
        message,
        service: "freeq-drain",
        fields: { error: err instanceof Error ? err.message : String(err) },
      });
    } catch {
      // logging must never break the loop
    }
  }

  /**
   * Run the retention pass at most once per PRUNE_INTERVAL_MS. Returns the per-DB result
   * when it ran, or null when it was skipped (baseline tick or within the interval). The
   * first tick after a cold start only records a baseline and does NOT prune, so a fresh
   * DO never deletes on its very first alarm. Never throws — pruneAll is best-effort per DB.
   */
  private async maybePrune(): Promise<PruneAllResult | null> {
    const now = Date.now();
    const last = await this.state.storage.get<number>(LAST_PRUNE_KEY);
    if (last === undefined) {
      await this.state.storage.put(LAST_PRUNE_KEY, now); // baseline; defer pruning to a later tick
      return null;
    }
    if (now - last < PRUNE_INTERVAL_MS) return null;
    await this.state.storage.put(LAST_PRUNE_KEY, now);
    return pruneAll(this.env);
  }
}
