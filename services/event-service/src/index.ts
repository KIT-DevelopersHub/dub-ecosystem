// Worker entrypoint. Wires the runtime env (D1, Service Bindings, Queues) into
// AppDeps and serves the Hono app. This file must stay import-clean for `wrangler dev`.
//
// One extra non-Hono path: the Mac mini agent's outbound WebSocket for the AI digest
// (#879), bearer-checked HERE before the EventDigestHub DO is touched, and refused
// outright while the feature flag is OFF.
import type { ExecutionContext } from "@cloudflare/workers-types";
import { createApp } from "./app";
import { buildDeps, digestEnabled, hubStub } from "./deps";
import { secretEquals } from "./digest/secret";
import type { Env } from "./env";

export type { Env } from "./env";
export { buildDeps } from "./deps";
export { EventDigestHub } from "./digest-hub";

export const DIGEST_AGENT_PATH = "/agent/event-digest/ws";

export function agentUpgradeAllowed(request: Request, env: Env): boolean {
  if (!digestEnabled(env)) return false;
  const expected = env.DIGEST_AGENT_SECRET;
  const header = request.headers.get("Authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(expected && presented && secretEquals(presented, expected));
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === DIGEST_AGENT_PATH) {
      const stub = hubStub(env);
      if (!stub || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("not found", { status: 404 });
      if (!agentUpgradeAllowed(request, env)) return new Response("unauthorized", { status: 401 });
      return stub.fetch("https://event-digest-hub/ws/agent", request as never);
    }
    const requestId = request.headers.get("x-dub-request-id") ?? undefined;
    const app = createApp(buildDeps(env, requestId));
    return app.fetch(request as unknown as Request) as unknown as Response;
  },

  // NOTE: no scheduled() drain here. The freeq outbox is drained centrally by the
  // standalone freeq-drain worker (single aggregated cron). src/drain.ts is retained as
  // the topic->destination contract source (audit.record + evt.* defer) for freeq-drain.
  // The AI digest schedule is the EventDigestHub DO ALARM (no new Cron: the cap is full).
};

export { createApp } from "./app";
export { EventService } from "./service";
export { createD1EventRepo } from "./d1-repo";
export { InMemoryEventRepo } from "./memory-repo";
export {
  EVENT_SCHEMA_MIGRATION,
  EVENT_DETAILS_SCHEMA_MIGRATION,
  EVENT_SECTION_LAYOUT_SCHEMA_MIGRATION,
  EVENT_PAGE_LAYOUT_SCHEMA_MIGRATION,
  EVENT_VENUE_CAPACITY_SCHEMA_MIGRATION,
  EVENT_AI_DIGEST_SCHEMA_MIGRATION,
} from "./schema";
export type { AppDeps } from "./types";
