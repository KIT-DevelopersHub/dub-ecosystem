// app-health-monitor Durable Object: a self-rescheduling HOURLY alarm loop that REPLACES a Cron
// Trigger. The Workers Free plan's 5-cron ACCOUNT cap is already full of business crons and a DO
// alarm does not count against it — so hourly polling runs without displacing any of them (same
// pattern as usage-meter / freeq-drain). SQLite-backed (wrangler new_sqlite_classes; free-plan OK).
//
// Lifecycle: POST /internal/monitor/kick (app.ts) bootstraps the loop once via ensureAlarm().
// Thereafter alarm() reschedules itself each hour. alarm() reschedules FIRST, then runs the poll
// inside try/catch so a transient failure can never kill the loop.
import type { DurableObjectState } from "@cloudflare/workers-types";
import { consoleSink } from "@dub/observability";
import { POLL_INTERVAL_MS, SERVICE_NAME } from "./config";
import { createNotifier } from "./notify";
import { createD1Repo } from "./repo";
import { runCheckCycle } from "./monitor";
import type { Env } from "./env";

export class MonitorDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  // Bootstrap entrypoint (idempotent) — a kick while the loop already runs is a no-op.
  async fetch(_req: Request): Promise<Response> {
    const alarmAt = await this.ensureAlarm();
    return new Response(JSON.stringify({ ok: true, service: "app-health-monitor-do", alarmAt }), {
      headers: { "content-type": "application/json" },
    });
  }

  /** Schedule the first alarm if none is pending. Returns the pending alarm time. */
  async ensureAlarm(): Promise<number> {
    const existing = await this.state.storage.getAlarm();
    if (existing !== null) return existing;
    const at = Date.now() + POLL_INTERVAL_MS;
    await this.state.storage.setAlarm(at);
    return at;
  }

  // Fired hourly. Reschedule FIRST (loop survives even if the poll throws), then poll.
  async alarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    if (!this.env.DB) {
      consoleSink({ level: "warn", message: "health poll skipped: DB unbound", service: SERVICE_NAME });
      return;
    }
    try {
      const repo = createD1Repo(this.env.DB);
      const notifier = createNotifier(this.env);
      const summary = await runCheckCycle(this.env, repo, notifier);
      consoleSink({ level: "info", message: "health poll (DO alarm)", service: SERVICE_NAME, fields: { checked: summary.checked, down: summary.down } });
    } catch (err) {
      consoleSink({
        level: "error",
        message: "health poll failed (loop preserved)",
        service: SERVICE_NAME,
        fields: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}
