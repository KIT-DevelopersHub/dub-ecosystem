// Dependency container. buildDeps() wires the real implementations from Env; tests
// pass their own DepsFactory to inject fakes (no network, no real CF/D1).
import { sharedAuthzGranter } from "@dub/policy-gate";
import type { PermissionGranter } from "@dub/policy-gate";
import { createDbClient } from "@dub/db";
import type { Env } from "./env";
import type { DeployRepo } from "./repo";
import { createD1DeployRepo } from "./repo";
import type { CfClient } from "./cf-client";
import { createCfClient } from "./cf-client";
import type { AuditGateway } from "./audit";
import { createAuditGateway } from "./audit";
import type { EventBus } from "./events";
import { createEventBus } from "./events";
import type { DeployJobMessage } from "./jobs";
import { AUDIT_TOPIC, TOPIC_NOTIFICATION, outboxQueue, enqueueDeployJob } from "./outbox";

export const SERVICE_NAME = "deploy-service";

export interface Deps {
  repo: DeployRepo;
  cf: CfClient;
  audit: AuditGateway;
  /**
   * Which of the requested permission keys the caller holds (identity /authz/check). The
   * ONLY authorization dependency: it feeds `policyGate` in app.ts, which is the single
   * decision point. There is no auth client here any more — nothing in this service
   * performs a permission check of its own.
   */
  authz: PermissionGranter;
  events: EventBus;
  enqueueJob(msg: DeployJobMessage, opts?: { delaySeconds?: number }): Promise<void>;
}

export type DepsFactory = (env: Env, requestId?: string) => Deps;

export const buildDeps: DepsFactory = (env, requestId) => {
  const db = createDbClient(env.DB, { namespace: "deploy", ...(requestId ? { requestId } : {}) });
  return {
    repo: createD1DeployRepo(db),
    cf: createCfClient({
      accountId: env.CF_ACCOUNT_ID ?? "",
      ...(env.CF_API_BASE ? { apiBase: env.CF_API_BASE } : {}),
      tokenPages: env.CF_DEPLOY_TOKEN_PAGES ?? "",
      tokenDns: env.CF_DEPLOY_TOKEN_DNS ?? "",
      tokenRead: env.CF_DEPLOY_TOKEN_READ ?? "",
    }),
    // Prefer the real (paid) Queue binding when present; otherwise fall back to the
    // free-tier @dub/freeq D1 outbox shim so audit/event/job records are durably
    // persisted and drained later, never dropped.
    audit: createAuditGateway({
      auditBinding: env.SVC_AUDIT_LOG,
      auditQueue: env.AUDIT_QUEUE ?? outboxQueue(env.DB, AUDIT_TOPIC),
      serviceName: SERVICE_NAME,
    }),
    // sharedAuthzGranter, not createAuthzGranter: deps are rebuilt per request, so the
    // identity decision cache (ADR 0004) has to be memoized per Env to survive between
    // requests in the same isolate. The three dangerous infra:* keys bypass that cache in
    // both directions, which is what keeps the old `fresh: true` behaviour intact.
    authz: sharedAuthzGranter(env, env.SVC_IDENTITY, {
      caller: SERVICE_NAME,
      ...(requestId ? { requestId } : {}),
    }),
    events: createEventBus({ notificationQueue: env.EVT_NOTIFICATION ?? outboxQueue(env.DB, TOPIC_NOTIFICATION) }),
    async enqueueJob(msg, opts) {
      if (env.DEPLOY_JOBS) {
        await env.DEPLOY_JOBS.send(msg, opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined);
        return;
      }
      // Free tier: no private Queue -> append to the freeq outbox (delaySeconds dropped;
      // the Cron drain cadence governs the poll loop instead). See outbox.ts.
      await enqueueDeployJob(env.DB, msg);
    },
  };
};
