// Dependency container. buildDeps() wires the real implementations from Env; tests
// pass their own DepsFactory to inject fakes (no network, no real CF/D1).
import { createAuthClient } from "@dub/auth-client";
import type { AuthClient } from "@dub/auth-client";
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

export const SERVICE_NAME = "deploy-service";

export interface Deps {
  repo: DeployRepo;
  cf: CfClient;
  audit: AuditGateway;
  auth: AuthClient;
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
    audit: createAuditGateway({
      auditBinding: env.SVC_AUDIT_LOG,
      auditQueue: env.AUDIT_QUEUE,
      serviceName: SERVICE_NAME,
    }),
    auth: createAuthClient({ identityBinding: env.SVC_IDENTITY, serviceName: SERVICE_NAME }),
    events: createEventBus({ notificationQueue: env.EVT_NOTIFICATION }),
    async enqueueJob(msg, opts) {
      await env.DEPLOY_JOBS.send(msg, opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined);
    },
  };
};
