// Runtime composition root — builds all ports from the Worker Env. Kept separate
// from index.ts so tests can assemble the same graph with in-memory adapters.
import { createDbClient, newId, nowIso } from "@dub/db";
import { createServiceClient } from "@dub/http";
import { createAuthClient, type AuthClient } from "@dub/auth-client";
import type { Env } from "./env";
import { d1Stores } from "./store/d1";
import type { Stores } from "./store/types";
import { StubGithubApi, RealGithubApi, type GithubApiClient } from "./clients/github";
import { HttpTaskClient, type TaskServiceClient } from "./clients/task";
import { HttpIdentityClient, type IdentityUserClient } from "./clients/identity";
import { HttpEventClient, type EventExistenceClient } from "./clients/event";
import { QueuePublisher, buildPublisherEnv, buildAuditQueue, type Publisher } from "./events/publisher";
import { SyncEngine } from "./engine/sync";
import { GithubSyncService } from "./service";

const SERVICE_NAME = "github-sync";

export interface Runtime {
  stores: Stores;
  github: GithubApiClient;
  tasks: TaskServiceClient;
  identity: IdentityUserClient;
  events: EventExistenceClient;
  publisher: Publisher;
  engine: SyncEngine;
  service: GithubSyncService;
  auth: AuthClient;
  originDefault: "internal" | "github";
  selfLogins: string[];
  now: () => string;
}

export function buildRuntime(env: Env): Runtime {
  const db = createDbClient(env.DB, { namespace: "github" });
  const stores = d1Stores(db, nowIso);

  const taskClient = createServiceClient(env.SVC_TASK, { service: "task-service", caller: SERVICE_NAME });
  const identitySvc = createServiceClient(env.SVC_IDENTITY, { service: "identity-roster", caller: SERVICE_NAME });
  const eventSvc = createServiceClient(env.SVC_EVENT, { service: "event-service", caller: SERVICE_NAME });

  const tasks = new HttpTaskClient(taskClient);
  const identity = new HttpIdentityClient(identitySvc);
  const events = new HttpEventClient(eventSvc);
  // Ship the real GitHub App REST client when the App secret is present; otherwise
  // fall back to the fail-closed stub so the Worker still boots and every GitHub
  // operation surfaces GITHUB_NOT_CONFIGURED rather than silently no-op'ing.
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY?.trim();
  const github: GithubApiClient =
    appId && privateKeyPem
      ? new RealGithubApi({ auth: { appId, privateKeyPem } })
      : new StubGithubApi();

  // Prefer real (paid) Queue bindings; fall back to the @dub/freeq D1 outbox on free tier.
  const publisher = new QueuePublisher(buildPublisherEnv(env), buildAuditQueue(env));

  const originDefault = (env.GITHUB_ORIGIN_DEFAULT === "internal" ? "internal" : "github") as "internal" | "github";
  const selfLogins = (env.GITHUB_SELF_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const engine = new SyncEngine({
    stores,
    github,
    tasks,
    identity,
    publisher,
    config: { selfLogins, originDefault },
    newId,
    now: nowIso,
  });

  const service = new GithubSyncService({
    stores,
    github,
    events,
    publisher,
    engine,
    newId,
    now: nowIso,
    originDefault,
  });

  const auth = createAuthClient({
    identityBinding: env.SVC_IDENTITY,
    serviceName: SERVICE_NAME,
    mode: "trustedHeader",
  });

  return { stores, github, tasks, identity, events, publisher, engine, service, auth, originDefault, selfLogins, now: nowIso };
}
