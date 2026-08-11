// usage-meter Durable Object: a self-rescheduling DAILY alarm loop that REPLACES a Cron
// Trigger. The Workers Free plan's 5-cron ACCOUNT cap is already full of business crons and
// a DO alarm does not count against it — so daily usage collection runs without displacing
// any of them. SQLite-backed (see wrangler.toml new_sqlite_classes; free-plan compatible),
// so alarms + storage (used here for per-day alert dedup) are available.
//
// Lifecycle: POST /internal/meter/kick (app.ts) bootstraps the loop once via ensureAlarm().
// Thereafter alarm() reschedules itself each day. alarm() reschedules FIRST, then runs the
// collection inside try/catch so a transient failure can never kill the loop.
import type { DurableObjectState } from "@cloudflare/workers-types";
import { consoleSink } from "@dub/observability";
import type { Env } from "./env";
import { collectSnapshot } from "./collect";
import { mailReadDb, upsertSnapshot, usageDb } from "./snapshot-repo";
import { buildSummary } from "./summary";
import { runAlerts, type DedupStore } from "./alerts";

export const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

const SERVICE = "usage-meter";

export class MeterDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  // Bootstrap entrypoint (idempotent) — a kick while the loop already runs is a no-op.
  async fetch(_req: Request): Promise<Response> {
    const alarmAt = await this.ensureAlarm();
    return new Response(JSON.stringify({ ok: true, service: "usage-meter-do", alarmAt }), {
      headers: { "content-type": "application/json" },
    });
  }

  /** Schedule the first alarm if none is pending. Returns the pending alarm time. */
  async ensureAlarm(): Promise<number> {
    const existing = await this.state.storage.getAlarm();
    if (existing !== null) return existing;
    const at = Date.now() + DAILY_INTERVAL_MS;
    await this.state.storage.setAlarm(at);
    return at;
  }

  // Fired daily. Reschedule FIRST (loop stays alive even if collection throws), then collect.
  async alarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + DAILY_INTERVAL_MS);
    try {
      const res = await this.runCollection(new Date());
      consoleSink({ level: "info", message: "usage collection (DO alarm)", service: SERVICE, fields: { ...res } });
    } catch (err) {
      consoleSink({
        level: "error",
        message: "usage collection failed (loop preserved)",
        service: SERVICE,
        fields: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /** Collect -> upsert -> alert. Also invoked by POST /internal/meter/refresh (without the
   *  alert step — see app.ts) via the shared collect/upsert helpers. Returns a small summary. */
  async runCollection(now: Date): Promise<{ metrics: number; worstStatus: string; newlyAlerted: number }> {
    if (!this.env.DB) {
      consoleSink({ level: "warn", message: "usage collection skipped: DB unbound", service: SERVICE });
      return { metrics: 0, worstStatus: "unknown", newlyAlerted: 0 };
    }
    const log = (msg: string, fields?: Record<string, unknown>) =>
      consoleSink({ level: "info", message: msg, service: SERVICE, ...(fields ? { fields } : {}) });

    const rows = await collectSnapshot(this.env, mailReadDb(this.env.DB), now, log);
    await upsertSnapshot(usageDb(this.env.DB), rows, now);
    const summary = buildSummary(rows, now);
    const alertRes = await runAlerts(this.env, summary, now, this.dedupStore(), log);
    return { metrics: rows.length, worstStatus: summary.worstStatus, newlyAlerted: alertRes.newlyAlerted.length };
  }

  /** Per-day alert dedup backed by DO SQLite storage. */
  private dedupStore(): DedupStore {
    const storage = this.state.storage;
    return {
      async seen(key: string): Promise<boolean> {
        return (await storage.get<boolean>(key)) === true;
      },
      async mark(key: string): Promise<void> {
        await storage.put(key, true);
      },
    };
  }
}
