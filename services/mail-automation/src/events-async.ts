// Free-tier event landing (改善#5). On the free plan there is no Cloudflare Queue consumer;
// domain events sit in the shared freeq_outbox and are forwarded by the freeq-drain worker,
// which POSTs each envelope (verbatim, with the x-dub-internal marker) to a consumer's
// /internal/events-async route. This module is that route's handler for mail-automation, so
// mail.message.received actually reaches the auto-reply pipeline instead of sitting pending
// forever. It is transport-agnostic and idempotent (event id is the dedup key), sharing the
// EXACT handler map the Queue consumer uses, so paid + free tiers run identical logic.
import { consoleSink } from "@dub/observability";
import type { DubEventEnvelope, DubEventHandlerMap } from "@dub/events";
import type { RequestContext } from "@dub/http";
import type { MailAutoRepo } from "./repo";
import { processInbound, type PipelineDeps } from "./pipeline";

const SERVICE_NAME = "mail-automation";

/** The SINGLE handler map for every event this service subscribes to. Shared by the Queue
 *  consumer (index.ts queue()) and the free-tier events-async route so both are identical. */
export function eventHandlers(pipeline: PipelineDeps): DubEventHandlerMap {
  return {
    "mail.message.received": async (event, { requestId }) => {
      const { messageId } = event.payload;
      const ctx: RequestContext = { requestId };
      const full = await pipeline.gateway.getMessage(ctx, messageId);
      await processInbound(pipeline, full, {}, { requestId, actorId: event.actorId });
    },
  };
}

export type DispatchResult = "ok" | "duplicate" | "unknown";

/** Dispatch ONE decoded envelope through the shared handler map, with idempotency. Throws on
 *  a handler failure so the caller can signal a retry (the freeq row stays pending, never a
 *  silent ack/drop). "unknown" = an event this service does not subscribe to (safe to ack). */
export async function dispatchEnvelope(repo: MailAutoRepo, pipeline: PipelineDeps, event: DubEventEnvelope): Promise<DispatchResult> {
  const handler = (eventHandlers(pipeline) as Record<string, ((e: DubEventEnvelope, c: { requestId: string }) => Promise<void>) | undefined>)[event.name];
  if (!handler) return "unknown";
  if (await repo.wasEventProcessed(event.id)) return "duplicate";
  await handler(event, { requestId: event.requestId });
  await repo.markEventProcessed(event.id);
  return "ok";
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The /internal/events-async landing handler. The internal-marker gate is applied by the
 *  caller (Worker entry) before this runs. 200 => freeq marks the row done (ok/duplicate/
 *  unknown are all ACK-worthy); 400 => malformed (also acked — a poison row that will never
 *  parse must not loop forever); 500 => handler threw, so the drain keeps the row and retries. */
export async function handleEventsAsync(request: Request, deps: { repo: MailAutoRepo; pipeline: PipelineDeps }): Promise<Response> {
  let event: DubEventEnvelope;
  try {
    event = (await request.json()) as DubEventEnvelope;
  } catch {
    return jsonResponse({ error: { code: "EVENTS_ENVELOPE_INVALID", message: "invalid json" } }, 400);
  }
  if (!event || typeof event.name !== "string" || typeof event.id !== "string") {
    return jsonResponse({ error: { code: "EVENTS_ENVELOPE_INVALID", message: "malformed envelope" } }, 400);
  }
  try {
    const result = await dispatchEnvelope(deps.repo, deps.pipeline, event);
    return jsonResponse({ status: result }, 200);
  } catch (err) {
    consoleSink({
      level: "error",
      message: "mail-automation: events-async handler failed; drain will retry",
      service: SERVICE_NAME,
      requestId: event.requestId,
      fields: { eventId: event.id, eventName: event.name, error: err instanceof Error ? err.message : String(err) },
    });
    return jsonResponse({ error: { code: "EVENTS_HANDLER_FAILED", message: "handler failed" } }, 500);
  }
}
