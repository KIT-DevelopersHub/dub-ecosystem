// Hono app factory. Routes:
//   EXT  POST /hooks/:source              external webhook ingress (enabled sources only; else 404)
//   EXT  GET  /hooks/:source              endpoint reachability handshake (enabled -> 200; else 404)
//   GW   GET  /api/v1/webhooks/deliveries administrative delivery search (webhook:read)
//   GW   GET  /api/v1/webhooks/deliveries/:id
//   SB   GET  /internal/health
import { Hono, type MiddlewareHandler } from "hono";
import { createAuthClient } from "@dub/auth-client";
import { createDbClient } from "@dub/db";
import { DubError, dubErrorHandler, errors } from "@dub/errors";
import { newRequestId } from "@dub/http";
import { consoleSink } from "@dub/observability";
import type { identity, webhook } from "@dub/types";
import {
  ENABLED_SOURCES,
  isWebhookSource,
  MAX_BODY_BYTES,
  OFFLOAD_THRESHOLD_BYTES,
  type Env,
} from "./env";
import { createDeliveryRepo, type DeliveryRepo } from "./repo";
import { ingest, type IngestDeps } from "./ingest";
import { secretsFromEnv, VERIFIERS, pickAllowlistedHeaders, type Verifier } from "./verify";

type Variables = { authn?: unknown; dubCtx?: unknown };
export type WebhookApp = Hono<{ Bindings: Env; Variables: Variables }>;

export interface AppOptions {
  /** Override ingest deps (tests inject fakes). */
  buildDeps?: (env: Env) => IngestDeps;
  /** Override delivery repo for admin query (tests inject fakes). */
  buildRepo?: (env: Env) => DeliveryRepo;
  /** Override verifier registry (tests). */
  verifiers?: Partial<Record<webhook.WebhookSource, Verifier>>;
  /** Override admin authz chain (tests bypass identity). */
  requireWebhookRead?: MiddlewareHandler;
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

// webhook:read is a pending PERMISSION_CATALOG addition (受口一本化 波及タスク; not yet in
// the frozen @dub/types union). Cast until identity-roster (#3) registers the key.
const WEBHOOK_READ = "webhook:read" as identity.PermissionKey;

function defaultRequireWebhookRead(): MiddlewareHandler {
  return async (c, next) => {
    const env = c.env as Env;
    const authClient = createAuthClient({ identityBinding: env.SVC_IDENTITY, serviceName: "webhook-ingest" });
    await authClient.requireAuth()(c, async () => {
      await authClient.requirePermission(WEBHOOK_READ)(c, next);
    });
  };
}

export function createApp(opts: AppOptions = {}): WebhookApp {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(dubErrorHandler({ service: "webhook-ingest" }));

  const buildDeps = opts.buildDeps ?? defaultDeps;
  const buildRepo = opts.buildRepo ?? defaultRepo;
  const verifiers = { ...VERIFIERS, ...(opts.verifiers ?? {}) };
  const enabled = opts.enabledSources ?? ENABLED_SOURCES;
  const requireWebhookRead = opts.requireWebhookRead ?? defaultRequireWebhookRead();

  // ---- health ----
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

  // ---- administrative query (via api-gateway; webhook:read) ----
  app.get("/api/v1/webhooks/deliveries", requireWebhookRead, async (c) => {
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

  app.get("/api/v1/webhooks/deliveries/:id", requireWebhookRead, async (c) => {
    const row = await buildRepo(c.env as Env).getById(c.req.param("id"));
    if (!row) throw errors.notFound("webhook delivery", c.req.param("id"));
    return c.json(row satisfies webhook.WebhookDelivery);
  });

  return app;
}
