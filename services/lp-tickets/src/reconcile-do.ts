// Ticket payment reconcile Durable Object: a self-rescheduling alarm loop that replaces the Cron
// Trigger on the free plan. The account is at the Workers FREE 5-cron cap; a DO alarm does not
// count against it (same pattern as github-sync's GithubReconcileDO).
//
// Lifecycle: every checkout that holds or sells a seat arms the loop (TicketService.armReconcile ->
// fetch -> ensureAlarm), so it starts by itself with the first sale — no manual bootstrap to forget.
// Thereafter alarm() reschedules itself first, then reconciles, so a throwing pass never stops the loop.
// While mail is backed up the alarm comes back after a minute and only drains; the full pass (Stripe,
// sweep, backup) keeps its 10-minute rhythm.
// SQLite-backed DO (wrangler.free.toml new_sqlite_classes) is available on the free plan.
import type { DurableObjectState } from "@cloudflare/workers-types";
import { buildDeps } from "./deps";
import { TicketService } from "./tickets";
import type { Env } from "./env";

// Matches the paid topology's every-10-minutes cron (wrangler.toml).
export const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
export const BACKLOG_INTERVAL_MS = 60 * 1000;
const LAST_FULL_KEY = "lastFullAt";

export class TicketReconcileDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  // Idempotent: a pending alarm is only ever moved earlier, so frequent arms do not delay the next pass.
  async fetch(req: Request): Promise<Response> {
    const soon = new URL(req.url).searchParams.get("soon") === "1";
    const target = Date.now() + (soon ? BACKLOG_INTERVAL_MS : RECONCILE_INTERVAL_MS);
    let at = await this.state.storage.getAlarm();
    if (at === null || at > target) {
      at = target;
      await this.state.storage.setAlarm(at);
    }
    return Response.json({ ok: true, alarmAt: at });
  }

  async alarm(): Promise<void> {
    const started = Date.now();
    await this.state.storage.setAlarm(started + RECONCILE_INTERVAL_MS);
    const service = new TicketService(buildDeps(this.env));
    const lastFull = (await this.state.storage.get<number>(LAST_FULL_KEY)) ?? 0;
    let backlog: number;
    if (started - lastFull >= RECONCILE_INTERVAL_MS - BACKLOG_INTERVAL_MS) {
      backlog = (await service.reconcile()).mailBacklog;
      await this.state.storage.put(LAST_FULL_KEY, started);
    } else {
      backlog = (await service.drainMail()).mailBacklog;
    }
    if (backlog > 0) await this.state.storage.setAlarm(Date.now() + BACKLOG_INTERVAL_MS);
  }
}
