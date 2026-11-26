// Runtime wiring of AppDeps from the Worker env. Split out of index.ts so the
// EventDigestHub DO (digest-hub.ts) can build the same deps without an import cycle.
import type { Queue } from "@cloudflare/workers-types";
import { createDbClient, newId, nowIso } from "@dub/db";
import { createAuthClient } from "@dub/auth-client";
import { sharedAuthzGranter } from "@dub/policy-gate";
import { createEvent, publishEvent, publishAudit, type AuditRecordEnvelopeV1, type DubEventEnvelope } from "@dub/events";
import { common, type auditLog } from "@dub/types";
import { consoleSink } from "@dub/observability";
import { createD1EventRepo } from "./d1-repo";
import { buildTaskClient } from "./task-client";
import { AUDIT_TOPIC, buildPublisherEnv, outboxQueue } from "./outbox";
import { buildRemoteCollectors } from "./digest/collectors";
import { createD1DigestRepo } from "./digest/repo";
import { createFakeProvider, createOfflineProvider } from "./digest/providers";
import { createRelayProvider, type HubStub } from "./digest/relay-provider";
import type { DigestDeps } from "./digest/types";
import type { Env } from "./env";
import type { AppDeps, EventPublisher, AuditSink } from "./types";

/** Feature flag. Default OFF: anything but "1"/"true" keeps the AI digest disabled. */
export function digestEnabled(env: Pick<Env, "EVENT_AI_DIGEST_ENABLED">): boolean {
  const v = (env.EVENT_AI_DIGEST_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export function hubStub(env: Env): HubStub | null {
  if (!env.DIGEST_HUB) return null;
  return env.DIGEST_HUB.get(env.DIGEST_HUB.idFromName("hub")) as unknown as HubStub;
}

export function buildDigestDeps(env: Env, db: ReturnType<typeof createDbClient>): DigestDeps {
  const mode = (env.EVENT_AI_DIGEST_PROVIDER ?? "relay").trim().toLowerCase();
  const stub = hubStub(env);
  const provider =
    mode === "fake" ? createFakeProvider() : mode === "relay" && stub ? createRelayProvider(stub) : createOfflineProvider();
  return {
    enabled: digestEnabled(env),
    provider,
    collectors: buildRemoteCollectors(env),
    repo: createD1DigestRepo(db),
  };
}

function buildPublisher(env: Env): EventPublisher {
  // Prefer real (paid) Queue bindings when present; otherwise fan out into the
  // free-tier @dub/freeq D1 outbox so no subscriber's event is dropped.
  const pubEnv = buildPublisherEnv(env.DB, env as unknown as Partial<Record<string, Queue<DubEventEnvelope>>>);
  return {
    async publish(name, payload, ctx) {
      const envelope = createEvent(name, payload, ctx);
      await publishEvent(pubEnv, envelope);
    },
  };
}

function buildAudit(env: Env): AuditSink {
  // Real AUDIT_QUEUE when present, else the freeq outbox — audit is now always
  // durably persisted (never silently dropped when the queue binding is absent).
  const auditQueue = (env.AUDIT_QUEUE ?? outboxQueue<AuditRecordEnvelopeV1>(env.DB, AUDIT_TOPIC)) as Queue<AuditRecordEnvelopeV1>;
  return {
    async record(input: auditLog.AuditRecordInput) {
      await publishAudit({ AUDIT_QUEUE: auditQueue }, input);
    },
  };
}

export function buildDeps(env: Env, requestId?: string): AppDeps {
  const db = createDbClient(env.DB, {
    namespace: "event",
    ...(requestId ? { requestId } : {}),
    logger: (e) => consoleSink({ level: "debug", message: "db", service: "event-service", fields: { sql: e.sql, ms: e.durationMs } }),
  });
  // Layer 1 — the POLICY_TABLE granter. sharedAuthzGranter (not createAuthzGranter): the app
  // is rebuilt per request, so the identity /authz/check TTL cache has to be memoized per Env
  // to survive between requests in the same isolate — otherwise every gated route is an
  // unconditional identity subrequest and identity-roster becomes a hot-path SPOF (ADR 0004).
  const authz = sharedAuthzGranter(env, env.SVC_IDENTITY, {
    caller: "event-service",
    ...(requestId ? { requestId } : {}),
  });
  // Layer 2 — the one event-scoped, body-dependent assertion (backward phase transition).
  const scopedAuthz = createAuthClient({
    identityBinding: env.SVC_IDENTITY,
    serviceName: "event-service",
    mode: "trustedHeader",
  });
  return {
    repo: createD1EventRepo(db),
    authz,
    scopedAuthz,
    publisher: buildPublisher(env),
    audit: buildAudit(env),
    taskClient: buildTaskClient(env.SVC_TASK),
    orgId: env.DUB_DEFAULT_ORG_ID ?? common.DUB_DEFAULT_ORG_ID,
    now: nowIso,
    newEventId: () => newId("event"),
    newActionId: () => newId("action"),
    digest: buildDigestDeps(env, db),
  };
}
