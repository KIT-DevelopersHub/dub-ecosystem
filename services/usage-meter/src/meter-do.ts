// usage-meter Durable Object: a self-rescheduling DAILY alarm loop that REPLACES a Cron
// Trigger. The Workers Free plan's 5-cron ACCOUNT cap is already full of business crons and
// a DO alarm does not count against it — so daily usage collection runs without displacing
// any of them. SQLite-backed (see wrangler.toml new_sqlite_classes; free-plan compatible),
// so alarms + storage (used here for per-day alert dedup) are available.
//
// Lifecycle: POST /internal/meter/kick (app.ts) bootstraps the loop once via ensureAlarm().
// Thereafter alarm() reschedules itself each day. GET /usage/summary also calls ensureAlarm()
// whenever the latest snapshot is stale, so a lost alarm is re-armed by the next dashboard view.
//
// alarm() MUST NOT throw. A throwing alarm is retried 6 times within minutes and then dropped
// by the runtime — that is how the loop died in production on 2026-09-21 (7 x
// scriptThrewException, then no invocation at all) and nothing re-armed it.
import type { DurableObjectState } from "@cloudflare/workers-types";
import { consoleSink } from "@dub/observability";
import type { Env } from "./env";
import { collectSnapshot } from "./collect";
import { mailReadDb, upsertSnapshot, usageDb } from "./snapshot-repo";
import { buildSummary } from "./summary";
import { runAlerts, runCollectionFailureAlert, type DedupStore } from "./alerts";
import type { SnapshotRow } from "./types";

export const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const FIRST_RUN_DELAY_MS = 60 * 1000;

const SERVICE = "usage-meter";
const FAILURES_KEY = "collect:consecutiveFailures";
const LAST_SUCCESS_KEY = "collect:lastSuccessAt";

/** Why a collection that did not throw still measured nothing useful, or null if it did.
 *  Every Cloudflare metric unknown = the GraphQL read failed (revoked token, missing
 *  permission, API error); the upsert still runs, but this counts as a failed collection. */
export function collectionProblem(rows: readonly SnapshotRow[]): string | null {
  const cf = rows.filter((r) => r.provider === "cloudflare");
  if (cf.length > 0 && cf.every((r) => r.status === "unknown")) {
    return "Cloudflare の使用量を 1 件も取得できませんでした (API トークン・権限・GraphQL エラーを確認)";
  }
  return null;
}

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

  /** Schedule the first alarm if none is pending. Returns the pending alarm time. The first
   *  run is near-immediate so a (re-)armed loop refreshes stale data now, not in 24h. */
  async ensureAlarm(): Promise<number> {
    const existing = await this.state.storage.getAlarm();
    if (existing !== null) return existing;
    const at = Date.now() + FIRST_RUN_DELAY_MS;
    await this.state.storage.setAlarm(at);
    return at;
  }

  // Fired daily. Reschedule FIRST (loop stays alive even if collection fails), then collect.
  // Every step is caught: see the header for why a throw here kills the loop.
  async alarm(): Promise<void> {
    try {
      await this.state.storage.setAlarm(Date.now() + DAILY_INTERVAL_MS);
    } catch (err) {
      // The next stale dashboard read re-arms via ensureAlarm(); keep collecting today.
      this.logError("usage alarm reschedule failed", err);
    }

    const now = new Date();
    let problem: string | null;
    try {
      const res = await this.runCollection(now);
      problem = res.problem;
      consoleSink({ level: "info", message: "usage collection (DO alarm)", service: SERVICE, fields: { ...res } });
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
      this.logError("usage collection failed (loop preserved)", err);
    }

    try {
      await this.recordOutcome(problem, now);
    } catch (err) {
      this.logError("usage collection health update failed", err);
    }
  }

  /** Collect -> upsert -> alert. Also invoked by POST /internal/meter/refresh (without the
   *  alert step — see app.ts) via the shared collect/upsert helpers. Returns a small summary. */
  async runCollection(
    now: Date,
  ): Promise<{ metrics: number; worstStatus: string; newlyAlerted: number; problem: string | null }> {
    if (!this.env.DB) {
      consoleSink({ level: "warn", message: "usage collection skipped: DB unbound", service: SERVICE });
      return { metrics: 0, worstStatus: "unknown", newlyAlerted: 0, problem: "DB が未バインドです" };
    }
    const log = (msg: string, fields?: Record<string, unknown>) =>
      consoleSink({ level: "info", message: msg, service: SERVICE, ...(fields ? { fields } : {}) });

    const rows = await collectSnapshot(this.env, mailReadDb(this.env.DB), now, log);
    await upsertSnapshot(usageDb(this.env.DB), rows, now);
    const summary = buildSummary(rows, now, now.toISOString());
    const alertRes = await runAlerts(this.env, summary, now, this.dedupStore(), log);
    return {
      metrics: rows.length,
      worstStatus: summary.worstStatus,
      newlyAlerted: alertRes.newlyAlerted.length,
      problem: collectionProblem(rows),
    };
  }

  /** Track consecutive failures in DO storage and alert admins once they repeat. */
  private async recordOutcome(problem: string | null, now: Date): Promise<void> {
    const storage = this.state.storage;
    if (problem === null) {
      await storage.put(FAILURES_KEY, 0);
      await storage.put(LAST_SUCCESS_KEY, now.toISOString());
      return;
    }
    const failures = ((await storage.get<number>(FAILURES_KEY)) ?? 0) + 1;
    await storage.put(FAILURES_KEY, failures);
    const lastSuccessAt = (await storage.get<string>(LAST_SUCCESS_KEY)) ?? null;
    const log = (msg: string, fields?: Record<string, unknown>) =>
      consoleSink({ level: "warn", message: msg, service: SERVICE, ...(fields ? { fields } : {}) });
    await runCollectionFailureAlert(
      this.env,
      { consecutiveFailures: failures, lastError: problem, lastSuccessAt },
      now,
      this.dedupStore(),
      log,
    );
  }

  private logError(message: string, err: unknown): void {
    consoleSink({
      level: "error",
      message,
      service: SERVICE,
      fields: { error: err instanceof Error ? err.message : String(err) },
    });
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
