// Worker entrypoint. Wires the runtime env (D1, identity Service Binding) into AppDeps.
// Exports only the handlers and the Durable Object class: workerd treats entry exports as entrypoints.
import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { createApp } from "./app";
import { buildDeps } from "./deps";
import { TicketService } from "./tickets";
import type { Env } from "./env";

export type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const requestId = request.headers.get("x-dub-request-id") ?? undefined;
    const app = createApp(buildDeps(env, requestId));
    return app.fetch(request as unknown as Request) as unknown as Response;
  },
  // Ticket payment reconcile (safety net when the Stripe webhook is missing / misconfigured).
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await new TicketService(buildDeps(env)).reconcile();
  },
};

// Free plan: alarm-driven reconcile (no cron slot left on the account). See reconcile-do.ts.
export { TicketReconcileDO } from "./reconcile-do";
