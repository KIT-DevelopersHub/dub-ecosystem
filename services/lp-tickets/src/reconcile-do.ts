// Ticket payment reconcile Durable Object: a self-rescheduling alarm loop that replaces the Cron
// Trigger on the free plan. The account is at the Workers FREE 5-cron cap; a DO alarm does not
// count against it (same pattern as github-sync's GithubReconcileDO).
//
// Lifecycle: every paid checkout arms the loop (TicketService.armReconcile -> fetch -> ensureAlarm),
// so it starts by itself with the first sale — no manual bootstrap to forget. Thereafter alarm()
// reschedules itself first, then reconciles, so a throwing pass never stops the loop.
// SQLite-backed DO (wrangler.free.toml new_sqlite_classes) is available on the free plan.
import type { DurableObjectState } from "@cloudflare/workers-types";
import { buildDeps } from "./deps";
import { TicketService } from "./tickets";
import type { Env } from "./env";

// Matches the paid topology's every-10-minutes cron (wrangler.toml).
export const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;

export class TicketReconcileDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  // Idempotent: a pending alarm is never moved, so frequent arms do not delay the next pass.
  async fetch(_req: Request): Promise<Response> {
    let at = await this.state.storage.getAlarm();
    if (at === null) {
      at = Date.now() + RECONCILE_INTERVAL_MS;
      await this.state.storage.setAlarm(at);
    }
    return Response.json({ ok: true, alarmAt: at });
  }

  async alarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);
    await new TicketService(buildDeps(this.env)).reconcile();
  }
}
