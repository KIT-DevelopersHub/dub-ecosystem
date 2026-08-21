// Cross-service smoke "world": one seeded node:sqlite D1 shared by the REAL Hono
// apps / repos of event-service, task-service, notification and mail-gateway, wired
// with small in-process fakes for the seams that would otherwise need the Cloudflare
// runtime (authz, service bindings, Queues, mail provider). Every leg that has domain
// substance runs the service's own code + SQL; only transport is faked. Owns only
// packages/e2e-smoke.
import type { MiddlewareHandler } from "hono";
import type { Queue } from "@cloudflare/workers-types";
import { createDbClient, newId, nowIso, type DbClient } from "@dub/db";
import { errors } from "@dub/errors";
import { common } from "@dub/types";
import type { DubEventEnvelope, AuditRecordEnvelopeV1 } from "@dub/events";

import {
  createApp as createEventApp,
  createD1EventRepo,
  type AppDeps as EventDeps,
} from "../../../services/event-service/src/index";
import type { Authz } from "../../../services/event-service/src/types";
import { buildApp as buildTaskApp } from "../../../services/task-service/src/app";
import { createD1TaskRepo } from "../../../services/task-service/src/repo";
import type { Deps as TaskDeps } from "../../../services/task-service/src/deps";
import type { AppConfig } from "../../../services/task-service/src/env";
import { MockMailProvider } from "../../../services/mail-gateway/src/provider";
import type { SendDeps } from "../../../services/mail-gateway/src/types";

import { makeSeededD1 } from "./d1";

export const ORG = common.DUB_DEFAULT_ORG_ID;

export const USERS = {
  organizer: "usr_org00000000000000000000",
  member: "usr_member0000000000000000000",
} as const;

/** A Queue that records everything sent (stands in for real Cloudflare Queues). */
export function recordingQueue<T>(): { queue: Queue<T>; sends: T[] } {
  const sends: T[] = [];
  const queue = {
    async send(msg: T) {
      sends.push(msg);
    },
    async sendBatch(batch: Iterable<{ body: T }>) {
      for (const m of batch) sends.push(m.body);
    },
  } as unknown as Queue<T>;
  return { queue, sends };
}

/** Authz fake: enforces the x-dub-user-id presence contract, grants every permission. */
function allowAuthz(): Authz {
  return {
    requireAuth(): MiddlewareHandler {
      return async (c, next) => {
        if (!c.req.header("x-dub-user-id")) throw errors.unauthenticated("x-dub-user-id absent");
        await next();
      };
    },
    requirePermission(): MiddlewareHandler {
      return async (_c, next) => next();
    },
    async hasPermission(): Promise<boolean> {
      return true;
    },
  };
}

export interface World {
  raw: ReturnType<typeof makeSeededD1>["raw"];
  eventApp: ReturnType<typeof createEventApp>;
  taskApp: ReturnType<typeof buildTaskApp>;
  notifDb: DbClient;
  mailDb: DbClient;
  /** Envelopes the REAL task-service emitted through its publisher seam. */
  emitted: DubEventEnvelope[];
  /** Build SendDeps for the REAL mail-gateway send core (records queue fan-out). */
  makeSendDeps(): SendDeps;
}

export function createWorld(): World {
  const { d1, raw } = makeSeededD1();

  const eventDb = createDbClient(d1, { namespace: "event" });
  const taskDb = createDbClient(d1, { namespace: "task" });
  const notifDb = createDbClient(d1, { namespace: "notif" });
  const mailDb = createDbClient(d1, { namespace: "mail" });

  // ---- event-service (REAL app + REAL D1 repo) ----
  const eventRepo = createD1EventRepo(eventDb);
  const eventDeps: EventDeps = {
    repo: eventRepo,
    authz: allowAuthz(),
    publisher: { publish: async () => {} },
    audit: { record: async () => {} },
    taskClient: { listAssigneeIds: async () => [] },
    orgId: ORG,
    now: nowIso,
    newEventId: () => newId("event"),
    newActionId: () => newId("action"),
  };
  const eventApp = createEventApp(eventDeps);

  // ---- task-service (REAL app + REAL D1 repo); capture emitted envelopes ----
  const emitted: DubEventEnvelope[] = [];
  const taskConfig: AppConfig = {
    environment: "test",
    orgId: ORG,
    dueSoonWindowMs: 24 * 60 * 60 * 1000,
    serviceCallers: new Set<string>(),
  };
  const taskDeps: TaskDeps = {
    config: taskConfig,
    repo: createD1TaskRepo(taskDb),
    events: {
      publish: async (envelopes) => {
        emitted.push(...envelopes);
      },
    },
    audit: { record: async () => {} },
    authz: { require: async () => {} },
    // Genuine cross-service ref: the event existence gate reads the REAL event row.
    eventClient: {
      getEvent: async (_ctx, id) => {
        const ev = await eventRepo.getEvent(id);
        return ev ? { archivedAt: ev.archivedAt } : null;
      },
    },
    identity: { userExists: async () => true },
    member: { teamsOfUser: async () => [] },
    idempotency: { wasProcessed: async () => false, markProcessed: async () => {} },
  };
  const taskApp = buildTaskApp(taskDeps);

  // ---- mail-gateway send core deps (REAL send.ts drives REAL mail_send_log) ----
  const makeSendDeps = (): SendDeps => ({
    db: mailDb,
    provider: new MockMailProvider(),
    events: {
      EVT_MAIL_AUTOMATION: recordingQueue<DubEventEnvelope>().queue,
      EVT_NOTIFICATION: recordingQueue<DubEventEnvelope>().queue,
    },
    audit: { AUDIT_QUEUE: recordingQueue<AuditRecordEnvelopeV1>().queue },
    orgId: ORG,
    fromAddress: "info@developershub.jp",
    ctx: { requestId: "req_smoke", caller: "notification" },
  });

  return { raw, eventApp, taskApp, notifDb, mailDb, emitted, makeSendDeps };
}

export interface CallResult {
  status: number;
  json: any;
}

// Hono's `request` has overloads that don't unify with a plain function type, so
// accept it structurally with a Response|Promise<Response> return and await through.
export interface Requestable {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

/** Drive a REAL Hono app the way the gateway would (trusted-header propagation). */
export async function call(
  app: Requestable,
  method: string,
  path: string,
  init: { userId?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<CallResult> {
  const url = new URL(`http://svc${path}`);
  if (init.query) for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { "x-dub-request-id": "req_smoke" };
  if (init.userId) headers["x-dub-user-id"] = init.userId;
  const reqInit: RequestInit = { method, headers };
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    reqInit.body = JSON.stringify(init.body);
  }
  const res = await app.request(url.toString(), reqInit);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
