// Hono app factory. Routes:
//   EXT  POST /hooks/:source           external webhook ingress (enabled sources only; else 404)
//   EXT  GET  /hooks/:source           endpoint reachability handshake (enabled -> 200; else 404)
//   GW   GET  /webhooks/deliveries     administrative delivery search (webhook:read)
//   GW   GET  /webhooks/deliveries/:id
//   SB   GET  /internal/health
//
// AUTHORIZATION: none in this file. `policyGate` is mounted first and derives every
// authorization decision from POLICY_TABLE (src/policy-table.ts), which lists every route
// below. Do NOT add a permission check or an `x-dub-internal` guard to a route or a handler —
// add the route to the table (test/policy-table.test.ts fails if you forget).
//
// The per-source SIGNATURE verification inside POST /hooks/:source is a different thing and
// DOES stay here: it authenticates a request that carries no session, over the raw body
// bytes, and consults no permission key. See policy-table.ts for why that is not the double
// authorization the migration removed.
import { Hono, type MiddlewareHandler } from "hono";
import { createDbClient } from "@dub/db";
import { DubError, dubErrorHandler, errors } from "@dub/errors";
import { newRequestId } from "@dub/http";
import { consoleSink, HDR_REQUEST_ID } from "@dub/observability";
import { policyGate, sharedAuthzGranter, type PermissionGranter, type PolicyGateVars } from "@dub/policy-gate";
import type { webhook } from "@dub/types";
import {
  ENABLED_SOURCES,
  isWebhookSource,
  MAX_BODY_BYTES,
  OFFLOAD_THRESHOLD_BYTES,
  type Env,
} from "./env";
import { createDeliveryRepo, type DeliveryRepo } from "./repo";
import { ingest, type IngestDeps } from "./ingest";
import { POLICY_TABLE } from "./policy-table";
import { secretsFromEnv, VERIFIERS, pickAllowlistedHeaders, type Verifier } from "./verify";

const SERVICE = "webhook-ingest";

type Variables = PolicyGateVars;
export type WebhookApp = Hono<{ Bindings: Env; Variables: Variables }>;

export interface AppOptions {
  /** Override ingest deps (tests inject fakes). */
  buildDeps?: (env: Env) => IngestDeps;
  /** Override delivery repo for admin query (tests inject fakes). */
  buildRepo?: (env: Env) => DeliveryRepo;
  /** Override verifier registry (tests). */
  verifiers?: Partial<Record<webhook.WebhookSource, Verifier>>;
  /** Override the permission source (tests). Production builds one from SVC_IDENTITY. */
  granted?: PermissionGranter;
  /** Override enabled-source gate (tests). */
  enabledSources?: ReadonlySet<webhook.WebhookSource>;
}

function defaultRepo(env: Env): DeliveryRepo {
  const db = createDbClient(env.DUB_DB, {
    namespace: "webhook",
    logger: (e) => consoleSink({ level: "debug", message: "d1", fields: { sql: e.sql, ms: e.durationMs } }),
  });
  return createDeliveryRepo(db);
}

function defaultDeps(env: Env): IngestDeps {
  const queues: IngestDeps["queues"] = { WH_GITHUB: env.WH_GITHUB };
  if (env.WH_GOOGLE_DRIVE) queues.WH_GOOGLE_DRIVE = env.WH_GOOGLE_DRIVE;
  if (env.WH_GMAIL) queues.WH_GMAIL = env.WH_GMAIL;
  if (env.WH_STRIPE) queues.WH_STRIPE = env.WH_STRIPE;
  return { repo: defaultRepo(env), raw: env.WEBHOOK_RAW, queues };
}

export function createApp(opts: AppOptions = {}): WebhookApp {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(dubErrorHandler({ service: SERVICE }));

  const buildDeps = opts.buildDeps ?? defaultDeps;
  const buildRepo = opts.buildRepo ?? defaultRepo;
  const verifiers = { ...VERIFIERS, ...(opts.verifiers ?? {}) };
  const enabled = opts.enabledSources ?? ENABLED_SOURCES;

  // THE authorization layer. First and only — every route below is gated by POLICY_TABLE.
  //
  // It is a thin wrapper rather than a bare `policyGate({...})` for one reason: `createApp()`
  // runs once per isolate (index.ts), so there is no `env` — and therefore no SVC_IDENTITY
  // binding — at mount time. The wrapper builds the granter from `c.env` and delegates to the
  // real `policyGate`; no decision logic is re-implemented here. Same shape as api-gateway's
  // src/policy.ts, which has the identical constraint.
  //
  // `sharedAuthzGranter` (not `createAuthzGranter`): the granter is rebuilt per request, so the
  // identity /authz/check TTL cache has to be memoized per Env to survive between requests in
  // the same isolate — otherwise every gated route is an unconditional identity subrequest and
  // identity-roster becomes a hot-path single point of failure (ADR 0004). The two PUBLIC
  // ingress routes make no identity call at all, so the hot path (provider webhooks) is
  // unaffected either way.
  app.use("*", (c, next) => {
    const env = c.env;
    const granted =
      opts.granted ??
      sharedAuthzGranter(env, env.SVC_IDENTITY, {
        caller: SERVICE,
        requestId: c.req.header(HDR_REQUEST_ID) ?? newRequestId(),
      });
    const gate = policyGate({ service: SERVICE, table: POLICY_TABLE, granted });
    // `policyGate` is typed for an app that declares Variables only; this one also declares
    // Bindings (it needs `c.env` to be `Env`). Structurally compatible in one direction only,
    // so the cast lives at this single seam rather than spread through the app's types —
    // same seam api-gateway's src/policy.ts has, for the same reason.
    return (gate as unknown as MiddlewareHandler<{ Bindings: Env; Variables: Variables }>)(c, next);
  });

  // ---- health (INTERNAL in the table: reachable only over a Service Binding carrying
  // x-dub-internal, which is exactly how app-health-monitor probes it). ----
  app.get("/internal/health", (c) => c.json({ status: "ok", service: "webhook-ingest" }));

  // ---- external ingress ----
  app.post("/hooks/:source", async (c) => {
    const source = c.req.param("source");
    if (!isWebhookSource(source)) throw errors.notFound("webhook source", source);
    if (!enabled.has(source)) throw errors.notFound("webhook source", source); // stub not enabled (P0)

    const rawBytes = new Uint8Array(await c.req.arrayBuffer());
    if (rawBytes.byteLength > MAX_BODY_BYTES) {
      throw new DubError("PAYLOAD_TOO_LARGE", "webhook body exceeds 1MB", { status: 413 });
    }

    const verifier = verifiers[source];
    if (!verifier) throw errors.notFound("webhook source", source);
    const result = await verifier({ rawBytes, headers: c.req.raw.headers }, secretsFromEnv(c.env as Env));
    if (!result.ok) {
      // never leak the reason; never write D1 for unauthenticated requests
      consoleSink({ level: "warn", message: "webhook verify failed", service: "webhook-ingest", fields: { source, reason: result.reason } });
      throw new DubError("UNAUTHENTICATED", "signature verification failed", { status: 401 });
    }

    // small bodies must be valid JSON (signature already proves a trusted sender -> 400 ok).
    // Exception: Google Drive channel-watch notifications — notably the mandatory
    // `sync` handshake POST sent when a channel is created — arrive with an EMPTY body
    // and carry all state in X-Goog-* headers. Treat an empty google-drive body as
    // payload=null so the handshake can publish instead of 400-ing.
    const emptyBody = rawBytes.byteLength === 0;
    const allowEmpty = emptyBody && source === "google-drive";
    if (!allowEmpty && rawBytes.byteLength <= OFFLOAD_THRESHOLD_BYTES) {
      try {
        JSON.parse(new TextDecoder().decode(rawBytes));
      } catch {
        throw errors.validationFailed([{ field: "body", reason: "invalid_json" }], "webhook body is not valid JSON");
      }
    }

    const ack = await ingest(buildDeps(c.env as Env), {
      source,
      externalId: result.externalId,
      eventKind: result.eventKind,
      rawBytes,
      headers: pickAllowlistedHeaders(source, c.req.raw.headers),
      requestId: newRequestId(),
    });
    return c.json(ack satisfies webhook.WebhookIngestAck, 200);
  });

  // Endpoint-reachability handshake (e.g. Google Drive channel watch verifies the
  // callback URL responds). Ack for enabled sources; unknown/disabled stays 404.
  app.get("/hooks/:source", (c) => {
    const source = c.req.param("source");
    if (!isWebhookSource(source)) throw errors.notFound("webhook handshake", source);
    if (!enabled.has(source)) throw errors.notFound("webhook handshake", source);
    return c.json({ status: "ok", source }, 200);
  });

  // ---- administrative query (via api-gateway; webhook:read in the table) ----
  // Path is the POST-STRIP path: api-gateway removes API_PREFIX before forwarding, so an
  // external GET /api/v1/webhooks/deliveries arrives here as /webhooks/deliveries. Registering
  // it with the prefix (as this did until the policy-gate migration) made both admin routes
  // dead — 404 at the receiver for every gateway call. See inventory a-6 and
  // packages/types WEBHOOK_WIRE, which already names the live path.
  app.get("/webhooks/deliveries", async (c) => {
    const q: webhook.WebhookDeliveryQuery = {};
    const source = c.req.query("source");
    const status = c.req.query("status");
    const cursor = c.req.query("cursor");
    const limit = c.req.query("limit");
    if (source) {
      if (!isWebhookSource(source)) throw errors.validationFailed([{ field: "source", reason: "invalid" }]);
      q.source = source;
    }
    if (status) q.status = status as webhook.WebhookDeliveryStatus;
    if (cursor) q.cursor = cursor;
    if (limit) {
      const n = Number.parseInt(limit, 10);
      if (Number.isNaN(n) || n < 1) throw errors.validationFailed([{ field: "limit", reason: "invalid" }]);
      q.limit = n;
    }
    const page = await buildRepo(c.env as Env).query(q);
    return c.json(page satisfies webhook.WebhookDeliveryPage);
  });

  app.get("/webhooks/deliveries/:id", async (c) => {
    const row = await buildRepo(c.env as Env).getById(c.req.param("id"));
    if (!row) throw errors.notFound("webhook delivery", c.req.param("id"));
    return c.json(row satisfies webhook.WebhookDelivery);
  });

  return app;
}
