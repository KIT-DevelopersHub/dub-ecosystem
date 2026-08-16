// The ONE source of truth for topic -> destination on the shared freeq outbox.
//
// Why this exists: on the shared dub-core outbox every producer's rows live in the SAME
// freeq_outbox table. A per-service drain (the retired design) claimed ALL due rows but
// only understood its own topics, and for a FOREIGN/unknown topic it RETURNED — which
// @dub/freeq treats as a successful delivery and marks the row `done` (ACK). That silent
// ack DROPPED another service's message (the mis-ack data-loss bug).
//
// The fix: this map is the single authority. A topic either DELIVERS to a named service
// binding + path, or DEFERS. `routeFor` DEFAULTS to DEFER for any topic not in the map,
// and a deferral THROWS `OutboxDeferral` — so @dub/freeq keeps the row `pending`
// (durable, retried with backoff, NEVER acked). No topic is ever dropped by not knowing
// about it.
import type { Fetcher } from "@cloudflare/workers-types";
import type { Deliver } from "@dub/freeq";
import { HDR_INTERNAL, INTERNAL_HEADER_VALUE } from "@dub/observability";
import type { Env, ServiceBindingName } from "./env";

export const AUDIT_ASYNC_PATH = "/internal/audit-async";
export const EVENTS_ASYNC_PATH = "/internal/events-async";

// Thrown for topics with no live consumer route (explicit defer or the default). Keeps
// the outbox row pending/durable — it is redelivered on the next drain, never acked.
export class OutboxDeferral extends Error {
  constructor(topic: string) {
    super(`freeq-drain: no live consumer route for topic "${topic}"; row retained pending`);
    this.name = "OutboxDeferral";
  }
}

// A delivering route: POST the row payload verbatim (JSON) to `binding` at `path`, with
// the x-dub-internal Service-Binding marker. A non-2xx THROWS -> the row is retried with
// backoff and never lost.
export interface DeliverRoute {
  kind: "deliver";
  binding: ServiceBindingName;
  path: string;
  origin: string; // arbitrary; Service Bindings ignore the host, but fetch() needs a URL
}
export interface DeferRoute {
  kind: "defer";
}
export type Route = DeliverRoute | DeferRoute;

const DEFER: DeferRoute = { kind: "defer" };

// Topic -> destination. Verified topic strings:
//   audit.record            = AUDIT_TOPIC (publishAudit channel, all services)
//   evt.<consumer>          = eventTopic(consumer) from @dub/events CONSUMER_QUEUE_BINDINGS
//   deploy.job              = TOPIC_DEPLOY_JOB (deploy-service/src/outbox.ts)
// Only topics whose consumer exposes a live POST /internal/{audit,events}-async landing
// route DELIVER; everything else DEFERS (durable, never acked).
export const ROUTES: Readonly<Record<string, Route>> = {
  // audit fan-out -> audit-log async ingest (AuditRecordEnvelopeV1, forwarded verbatim).
  "audit.record": { kind: "deliver", binding: "SVC_AUDIT_LOG", path: AUDIT_ASYNC_PATH, origin: "https://audit-log" },

  // domain events -> the consumer's /internal/events-async landing route (DubEventEnvelope,
  // forwarded verbatim). LIVE consumers only (route grepped-confirmed present):
  "evt.task": { kind: "deliver", binding: "SVC_TASK", path: EVENTS_ASYNC_PATH, origin: "https://task-service" },
  "evt.gantt": { kind: "deliver", binding: "SVC_GANTT", path: EVENTS_ASYNC_PATH, origin: "https://gantt-service" },
  "evt.file-meta": { kind: "deliver", binding: "SVC_FILE_META", path: EVENTS_ASYNC_PATH, origin: "https://file-meta" },
  "evt.github-sync": { kind: "deliver", binding: "SVC_GITHUB_SYNC", path: EVENTS_ASYNC_PATH, origin: "https://github-sync" },
  "evt.mobile-bff": { kind: "deliver", binding: "SVC_MOBILE_BFF", path: EVENTS_ASYNC_PATH, origin: "https://mobile-bff" },
  // 改善#5: mail-automation now exposes /internal/events-async, so mail.message.received
  // is DELIVERED (auto-reply fires) instead of sitting pending forever on the free tier.
  "evt.mail-automation": { kind: "deliver", binding: "SVC_MAIL_AUTOMATION", path: EVENTS_ASYNC_PATH, origin: "https://mail-automation" },

  // No live consumer route yet -> DEFER (durable/pending; follow-ups when routes land):
  "evt.notification": DEFER, // notification has no /internal/events-async route
  "deploy.job": DEFER, // processed in-process inside deploy-service only; no HTTP route
};

/** Resolve a topic to its route. DEFAULT = DEFER (never ack an unknown topic). */
export function routeFor(topic: string): Route {
  return ROUTES[topic] ?? DEFER;
}

/**
 * The single delivery callback @dub/freeq's drain calls for every claimed row, across all
 * four bound outbox D1s. Deliver -> POST verbatim; defer / missing binding -> throw
 * OutboxDeferral (row stays pending). This is the mis-ack fix: nothing here ever silently
 * returns for a topic it does not own, so a foreign row is never marked done.
 */
export function makeDeliver(env: Env): Deliver {
  return async ({ topic, payload }) => {
    const route = routeFor(topic);
    if (route.kind === "defer") throw new OutboxDeferral(topic);

    const svc = env[route.binding] as Fetcher | undefined;
    if (!svc) throw new OutboxDeferral(topic); // binding absent at runtime: defer, don't crash

    const res = await svc.fetch(route.origin + route.path, {
      method: "POST",
      headers: { "content-type": "application/json", [HDR_INTERNAL]: INTERNAL_HEADER_VALUE },
      body: JSON.stringify(payload), // payload IS the envelope the producer built; verbatim
    });
    if (!res.ok) throw new Error(`freeq-drain: ${topic} -> ${route.binding}${route.path} returned ${res.status}`);
  };
}
