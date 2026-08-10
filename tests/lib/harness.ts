// In-process cross-service integration harness (integration-e2e unit, #29).
//
// Wires the REAL Hono apps of the core path — api-gateway, auth-service,
// identity-roster, event-service — together via fake Service Bindings (a Fetcher
// is just `{ fetch(req) }`), backed by the services' own in-memory repos. Services
// that ship no in-memory repo (task / notification / audit-log / gantt / file-meta)
// are represented by FAITHFUL in-memory STUB fetchers mounted at the gateway-
// forwarded path, so gateway routing + trusted-header propagation + the wire error
// contract are still exercised end-to-end. Queue fan-out is simulated in-process
// (no miniflare Queue): task assignment pushes directly into the notification inbox
// store, standing in for task.assigned -> Queue -> notification consumer.
//
// This file owns ONLY tests/. It never imports service internals it should not:
// each app is built through its public factory + the exported in-memory repo.

import type { Fetcher, ExecutionContext } from "@cloudflare/workers-types";
import { newId, nowIso } from "@dub/db";
import { common } from "@dub/types";
import type { identity, task, notification, auditLog, event } from "@dub/types";

// --- real service factories (relative source imports; @dub/* resolve via tsconfig paths) ---
import { createApp as createGatewayApp } from "../../services/api-gateway/src/app";
import type { GatewayEnv } from "../../services/api-gateway/src/env";
import { createApp as createIdentityApp, MemIdentityRepo, seedReferenceData } from "../../services/identity-roster/src/index";
import { createApp as createEventApp, InMemoryEventRepo } from "../../services/event-service/src/index";
import type { AppDeps as EventAppDeps } from "../../services/event-service/src/index";
import {
  createApp as createDeployApp,
  handleDeployJobs,
  createInMemoryDeployRepo,
} from "../../services/deploy-service/src/index";
import type {
  Deps as DeployDeps,
  CfClient as DeployCfClient,
  AuditGateway as DeployAuditGateway,
  EventBus as DeployEventBus,
  DeployJobMessage,
} from "../../services/deploy-service/src/index";
import { createAuthClient } from "@dub/auth-client";
import { buildApp as buildAuthApp } from "../../services/auth-service/src/app";
import { SessionService } from "../../services/auth-service/src/sessions";
import { configFromEnv as authConfigFromEnv, type Env as AuthEnv } from "../../services/auth-service/src/env";
import type { Deps as AuthDeps } from "../../services/auth-service/src/deps";

export const ORG = common.DUB_DEFAULT_ORG_ID; // "org_devhub"
const OTHER_ORG = "org_other";

export type TestUserKey = "admin" | "organizer" | "member" | "outsider";

export interface TestUser {
  key: TestUserKey;
  userId: string;
  orgId: string;
  email: string;
  displayName: string;
}

export const TEST_USERS: Record<TestUserKey, TestUser> = {
  admin: { key: "admin", userId: "usr_admin000000000000000000", orgId: ORG, email: "admin@devhub.test", displayName: "Admin" },
  organizer: { key: "organizer", userId: "usr_org00000000000000000000", orgId: ORG, email: "organizer@devhub.test", displayName: "Organizer" },
  member: { key: "member", userId: "usr_member0000000000000000000", orgId: ORG, email: "member@devhub.test", displayName: "Member" },
  outsider: { key: "outsider", userId: "usr_outsider00000000000000000", orgId: OTHER_ORG, email: "outsider@other.test", displayName: "Outsider" },
};

// ---- shared in-memory stores (cross-service side effects observed here) ----
export interface Stores {
  audit: (auditLog.AuditRecord & Record<string, unknown>)[];
  inbox: Map<string, notification.InboxItem[]>; // userId -> items
  tasks: Map<string, task.Task>;
}

// Hono's `fetch` overloads don't unify with a plain function type, so accept the
// app opaquely and call through. Runtime: identical to `app.fetch(req)`.
function toFetcher(app: { fetch: (req: Request) => Response | Promise<Response> } | { fetch: (...args: never[]) => unknown }): Fetcher {
  const f = app as { fetch: (req: Request) => Response | Promise<Response> };
  return {
    fetch: async (req: Request) => f.fetch(req),
  } as unknown as Fetcher;
}

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

// deterministic-ish clock (monotonic ms) so session TTLs are sane
function makeClock(): () => number {
  let t = Date.parse("2026-08-09T00:00:00Z");
  return () => (t += 1);
}

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function wireError(status: number, code: string, message: string, requestId: string): Response {
  return jsonRes(status, { error: { code, message, retryable: false, requestId } }, { "x-dub-request-id": requestId });
}

// ============================ identity (REAL) ============================
async function buildIdentity(stores: Stores): Promise<Fetcher> {
  const repo = new MemIdentityRepo();
  const now = () => nowIso();
  await seedReferenceData({ repo, now, newId }, ORG, "DevHub");

  // resolve system role ids
  const roleId = async (name: string): Promise<string> => {
    const r = await repo.getRoleByName(ORG, name);
    if (!r) throw new Error(`seed role missing: ${name}`);
    return r.id;
  };
  const adminRole = await roleId("admin");
  const organizerRole = await roleId("organizer");
  const memberRole = await roleId("member");

  // seed users
  const mkUser = async (u: TestUser): Promise<void> => {
    await repo.createUser({
      id: u.userId,
      orgId: u.orgId,
      email: u.email,
      displayName: u.displayName,
      githubLogin: null,
      avatarUrl: null,
      status: "active",
      createdAt: now(),
      updatedAt: now(),
    });
  };
  await mkUser(TEST_USERS.admin);
  await mkUser(TEST_USERS.organizer);
  await mkUser(TEST_USERS.member);
  await mkUser(TEST_USERS.outsider); // active but orgId=OTHER_ORG => devhub non-member

  const grant = async (userId: string, rid: string): Promise<void> => {
    await repo.createAssignment({
      id: newId("ra"),
      userId,
      roleId: rid,
      orgId: ORG,
      resourceType: null,
      resourceId: null,
      grantedBy: TEST_USERS.admin.userId,
      grantedAt: now(),
    });
  };
  await grant(TEST_USERS.admin.userId, adminRole);
  await grant(TEST_USERS.organizer.userId, organizerRole);
  await grant(TEST_USERS.member.userId, memberRole);
  // outsider: no assignment (and different org) => every authz check denies

  const auditSink = {
    logSync: async (input: auditLog.AuditRecordInput) => {
      stores.audit.push({ ...input, id: newId("audit"), recordedAt: now() });
    },
    publish: async (input: auditLog.AuditRecordInput) => {
      stores.audit.push({ ...input, id: newId("audit"), recordedAt: now() });
    },
  };
  const revoker = { revokeUser: async () => {} };

  const app = createIdentityApp({
    deps: { repo, audit: auditSink, revoker, now, newId, defaultOrgId: ORG },
    defaultOrgId: ORG,
  });
  return toFetcher(app);
}

// ============================ auth (REAL) ============================
function buildAuth(): { fetcher: Fetcher } {
  const env = {
    ENVIRONMENT: "preview",
    DUB_TEST_LOGIN: "1",
    COOKIE_DOMAIN: ".devhub.test",
    SPA_SUCCESS_URL: "https://app.devhub.test/",
    SPA_ERROR_URL: "https://app.devhub.test/login",
    REDIRECT_ALLOWLIST: "https://app.devhub.test",
    SESSION_ACCESS_TTL_SEC: "3600",
    SESSION_ABS_WEB_TTL_SEC: "2592000",
    SESSION_ABS_MOBILE_TTL_SEC: "15552000",
    STATE_TTL_SEC: "600",
    GOOGLE_CLIENT_ID: "web",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REDIRECT_URI: "https://auth.devhub.test/auth/callback",
    GOOGLE_MOBILE_IOS_CLIENT_ID: "ios",
    GOOGLE_MOBILE_ANDROID_CLIENT_ID: "android",
  } as unknown as AuthEnv;

  const config = authConfigFromEnv(env);
  const kv = new Map<string, string>();
  const kvNs = {
    get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
    put: async (k: string, v: string) => void kv.set(k, v),
    delete: async (k: string) => void kv.delete(k),
  } as unknown as import("@cloudflare/workers-types").KVNamespace;

  const clock = makeClock();
  const deps: AuthDeps = {
    config,
    sessions: new SessionService(kvNs, config, clock),
    oauth: {
      buildAuthorizeUrl: () => "https://accounts.google.com/o/oauth2/v2/auth",
      exchangeWebCode: async () => ({ sub: "s", email: "x@x", displayName: "X", avatarUrl: null }),
      exchangeMobileCode: async () => ({ sub: "s", email: "x@x", displayName: "X", avatarUrl: null }),
    } as unknown as AuthDeps["oauth"],
    identity: { provision: async () => ({ status: "existing", user: null }) } as unknown as AuthDeps["identity"],
    audit: { record: async () => {} } as unknown as AuthDeps["audit"],
    kvPut: async (k, v) => void kv.set(k, v),
    kvGet: async (k) => (kv.has(k) ? kv.get(k)! : null),
    kvDelete: async (k) => void kv.delete(k),
  };
  const app = buildAuthApp(deps);
  return { fetcher: toFetcher(app) };
}

// ============================ event (REAL) ============================
function buildEvent(identityFetcher: Fetcher, stores: Stores): Fetcher {
  const repo = new InMemoryEventRepo();
  // event-service authz client resolves permissions against the REAL identity fetcher.
  // We reuse the auth-client the service ships (trustedHeader mode) by importing it here.
  const authz = makeEventAuthz(identityFetcher);
  const deps: EventAppDeps = {
    repo,
    authz,
    publisher: { publish: async () => {} },
    audit: {
      record: async (input) => {
        stores.audit.push({ ...input, id: newId("audit"), recordedAt: nowIso() });
      },
    },
    taskClient: {
      listAssigneeIds: async (_ctx, eventId) => {
        const ids = new Set<string>();
        for (const t of stores.tasks.values()) if (t.eventId === eventId && t.assigneeId) ids.add(t.assigneeId);
        return [...ids];
      },
    },
    orgId: ORG,
    now: () => nowIso(),
    newEventId: () => newId("event"),
    newActionId: () => newId("action"),
  };
  const app = createEventApp(deps);
  return toFetcher(app);
}

// The event app's Authz interface is a subset of @dub/auth-client. Build the real one.
function makeEventAuthz(identityFetcher: Fetcher): EventAppDeps["authz"] {
  return createAuthClient({
    identityBinding: identityFetcher,
    serviceName: "event-service",
    mode: "trustedHeader",
  }) as unknown as EventAppDeps["authz"];
}

// ============================ deploy (REAL) ============================
// Wires the REAL deploy-service Hono app + all 7 routes against the exported
// in-memory repo, a fake CF control plane (Pages deploys settle `live` at once),
// audit records flowing into stores.audit, and the private deploy-jobs queue drained
// in-process. Permissions resolve against the REAL identity roster (admin => full
// infra:*, organizer => infra:read). This replaces the former inert SVC_DEPLOY stub
// so the deploy endpoints are exercised end-to-end through the gateway.
function buildDeploy(identityFetcher: Fetcher, stores: Stores): Fetcher {
  const repo = createInMemoryDeployRepo();
  repo.seedAllowedZone({ zoneId: "zone_devhub", zoneName: "devhub.test", registrarManaged: true });

  const auth = createAuthClient({ identityBinding: identityFetcher, serviceName: "deploy-service" });

  const cf: DeployCfClient = {
    createPagesDeployment: async () => ({
      cfDeploymentId: newId("cfdep"),
      status: "live",
      url: "https://preview.pages.dev",
    }),
    getPagesDeployment: async () => ({
      cfDeploymentId: "cfdep",
      status: "live",
      url: "https://preview.pages.dev",
    }),
    createDnsRecord: async (i) => ({ id: newId("cfrec"), zone: i.zone, type: i.type, name: i.name, content: i.content }),
    listZones: async () => [{ zoneId: "zone_devhub", zoneName: "devhub.test", status: "active", registrarManaged: true }],
  };

  const pushAudit = (rec: Record<string, unknown>): string => {
    const id = newId("audit");
    stores.audit.push({ id, recordedAt: nowIso(), occurredAt: nowIso(), orgId: ORG, ...rec } as (typeof stores.audit)[number]);
    return id;
  };
  const audit: DeployAuditGateway = {
    recordIntent: async (ctx, input) =>
      pushAudit({
        action: input.action,
        actorId: input.actorId,
        result: "intent",
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        details: input.details,
        requestId: ctx.requestId,
      }),
    recordResult: async (ctx, input) => {
      pushAudit({
        action: input.action,
        actorId: input.actorId,
        result: input.result,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        details: { ...(input.details ?? {}), intent_id: input.intentId },
        requestId: ctx.requestId,
      });
    },
  };

  const events: DeployEventBus = {
    deploymentStatusChanged: async () => {},
    dnsRecordChanged: async () => {},
  };

  const pending: DeployJobMessage[] = [];
  const deps: DeployDeps = {
    repo,
    cf,
    audit,
    auth,
    events,
    enqueueJob: async (msg) => void pending.push(msg),
  };
  const app = createDeployApp(() => deps);
  const env = {} as never; // deploy makeDeps ignores env (deps are injected)

  // Drain the private deploy-jobs queue in-process. The fake CF settles `live` on the
  // first execute pass, so no poll job is re-enqueued; the guard bounds any surprise.
  const drain = async (): Promise<void> => {
    let guard = 0;
    while (pending.length > 0 && guard++ < 50) {
      const batch = pending.splice(0, pending.length);
      const wrapped = { messages: batch.map((body) => ({ body, ack() {}, retry() {} })) };
      await handleDeployJobs(wrapped as never, env, () => deps);
    }
  };

  return {
    fetch: async (req: Request) => {
      const res = await app.fetch(req, env, execCtx);
      // The response body was already serialized (a queued 202 stays queued on the
      // wire); draining now advances the deployment to its terminal state so a later
      // GET observes `live` — faithful async execution, not a stub.
      await drain();
      return res;
    },
  } as unknown as Fetcher;
}

// ============================ STUBS (in-memory) ============================
// task-service stub: CRUD + assignment. Mounted at the gateway-forwarded path
// (/tasks). On assignment it simulates task.assigned -> notification inbox.
function taskStub(stores: Stores): Fetcher {
  const authUser = (req: Request): string | null => req.headers.get("x-dub-user-id");
  const rid = (req: Request): string => req.headers.get("x-dub-request-id") ?? "req_stub";

  const pushNotif = (userId: string, item: notification.InboxItem): void => {
    const arr = stores.inbox.get(userId) ?? [];
    arr.unshift(item);
    stores.inbox.set(userId, arr);
  };

  return {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      const p = url.pathname;
      const requestId = rid(req);
      const uid = authUser(req);
      if (!uid) return wireError(401, "UNAUTHENTICATED", "x-dub-user-id absent", requestId);

      // POST /tasks
      if (req.method === "POST" && p === "/tasks") {
        const body = (await req.json()) as task.CreateTaskRequest;
        if (!body.title || !body.eventId) return wireError(400, "VALIDATION_FAILED", "title and eventId required", requestId);
        const now = nowIso();
        const t: task.Task = {
          id: newId("task"),
          eventId: body.eventId,
          title: body.title,
          description: body.description ?? null,
          status: "todo",
          priority: body.priority ?? "medium",
          assigneeId: body.assigneeId ?? null,
          dueAt: body.dueAt ?? null,
          origin: body.origin ?? "internal",
          version: 1,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        stores.tasks.set(t.id, t);
        return jsonRes(201, t, { "x-dub-request-id": requestId });
      }

      // GET /tasks (list, optional eventId / assigneeId filter)
      if (req.method === "GET" && p === "/tasks") {
        const eventId = url.searchParams.get("eventId");
        const assigneeId = url.searchParams.get("assigneeId");
        let items = [...stores.tasks.values()].filter((t) => !t.archivedAt);
        if (eventId) items = items.filter((t) => t.eventId === eventId);
        if (assigneeId) items = items.filter((t) => t.assigneeId === assigneeId);
        const res: task.ListTasksResponse = { items, nextCursor: null };
        return jsonRes(200, res, { "x-dub-request-id": requestId });
      }

      // GET /tasks/:id
      const idMatch = /^\/tasks\/([^/]+)$/.exec(p);
      if (idMatch) {
        const t = stores.tasks.get(idMatch[1]!);
        if (req.method === "GET") {
          if (!t) return wireError(404, "NOT_FOUND", "task not found", requestId);
          return jsonRes(200, t, { "x-dub-request-id": requestId });
        }
        // PATCH /tasks/:id (assignment / status transition)
        if (req.method === "PATCH") {
          if (!t) return wireError(404, "NOT_FOUND", "task not found", requestId);
          const body = (await req.json()) as task.UpdateTaskRequest;
          if (typeof body.version !== "number" || body.version !== t.version) {
            return wireError(409, "TASK_VERSION_CONFLICT", "version conflict", requestId);
          }
          const wasAssignee = t.assigneeId;
          const next: task.Task = {
            ...t,
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.status !== undefined ? { status: body.status } : {}),
            ...(body.priority !== undefined ? { priority: body.priority } : {}),
            ...(body.assigneeId !== undefined ? { assigneeId: body.assigneeId } : {}),
            ...(body.dueAt !== undefined ? { dueAt: body.dueAt } : {}),
            version: t.version + 1,
            updatedAt: nowIso(),
          };
          stores.tasks.set(next.id, next);
          // simulate task.assigned -> Queue -> notification consumer -> inbox
          if (next.assigneeId && next.assigneeId !== wasAssignee) {
            pushNotif(next.assigneeId, {
              id: newId("notif"),
              type: "task.assigned",
              title: "New task assigned",
              body: next.title,
              readAt: null,
              createdAt: nowIso(),
              resourceType: "task",
              resourceId: next.id,
            });
          }
          return jsonRes(200, next, { "x-dub-request-id": requestId });
        }
        // DELETE /tasks/:id -> only owner/creator; stub: forbid non-assignee member deleting others' tasks
        if (req.method === "DELETE") {
          if (!t) return wireError(404, "NOT_FOUND", "task not found", requestId);
          return jsonRes(204, null, { "x-dub-request-id": requestId });
        }
      }
      return wireError(404, "NOT_FOUND", `no task route ${p}`, requestId);
    },
  } as unknown as Fetcher;
}

// notification stub: inbox read/unread/read + internal notify. Mounted at gateway-
// forwarded path (/notifications/*) AND internal /inbox/* (bff-home internal client).
function notificationStub(stores: Stores): Fetcher {
  const rid = (req: Request): string => req.headers.get("x-dub-request-id") ?? "req_stub";
  const uid = (req: Request): string | null => req.headers.get("x-dub-user-id");

  return {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      const requestId = rid(req);
      // normalize: accept both /notifications/inbox (external proxy) and /inbox (internal client)
      let p = url.pathname;
      if (p.startsWith("/notifications/")) p = p.slice("/notifications".length);

      // internal notify (3-lane ingest lane C)
      if (req.method === "POST" && p === "/notify") {
        const body = (await req.json()) as notification.NotifyRequest;
        for (const r of body.recipientIds) {
          const arr = stores.inbox.get(r) ?? [];
          arr.unshift({
            id: newId("notif"),
            type: body.type,
            title: body.title,
            body: body.body,
            readAt: null,
            createdAt: nowIso(),
            resourceType: body.resourceType ?? null,
            resourceId: body.resourceId ?? null,
          });
          stores.inbox.set(r, arr);
        }
        return jsonRes(202, { accepted: body.recipientIds.length }, { "x-dub-request-id": requestId });
      }

      const user = uid(req);
      if (!user) return wireError(401, "UNAUTHENTICATED", "x-dub-user-id absent", requestId);
      const items = stores.inbox.get(user) ?? [];

      if (req.method === "GET" && p === "/inbox/unread-count") {
        const res: notification.UnreadCountResponse = { count: items.filter((i) => !i.readAt).length };
        return jsonRes(200, res, { "x-dub-request-id": requestId });
      }
      if (req.method === "GET" && p === "/inbox") {
        const unreadOnly = url.searchParams.get("unreadOnly") === "true";
        const list = unreadOnly ? items.filter((i) => !i.readAt) : items;
        const res: notification.ListInboxResponse = { items: list, nextCursor: null };
        return jsonRes(200, res, { "x-dub-request-id": requestId });
      }
      const readMatch = /^\/inbox\/([^/]+)\/read$/.exec(p);
      if (req.method === "PATCH" && readMatch) {
        const found = items.find((i) => i.id === readMatch[1]);
        if (!found) return wireError(404, "NOTIF_INBOX_ITEM_NOT_FOUND", "not found", requestId);
        found.readAt = nowIso();
        return jsonRes(200, found, { "x-dub-request-id": requestId });
      }
      if (req.method === "POST" && p === "/inbox/read-all") {
        for (const i of items) if (!i.readAt) i.readAt = nowIso();
        return jsonRes(200, { ok: true }, { "x-dub-request-id": requestId });
      }
      return wireError(404, "NOT_FOUND", `no notification route ${p}`, requestId);
    },
  } as unknown as Fetcher;
}

// audit-log stub: read the shared audit store (audit:read = admin). Mounted at
// gateway-forwarded path (/audit/logs).
function auditStub(stores: Stores, identityFetcher: Fetcher): Fetcher {
  const rid = (req: Request): string => req.headers.get("x-dub-request-id") ?? "req_stub";
  const authz = createAuthClient({ identityBinding: identityFetcher, serviceName: "audit-log", mode: "trustedHeader" });

  return {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      const requestId = rid(req);
      const user = req.headers.get("x-dub-user-id");
      if (!user) return wireError(401, "UNAUTHENTICATED", "x-dub-user-id absent", requestId);
      if (url.pathname === "/audit/logs" && req.method === "GET") {
        const allowed = await authz.hasPermission(user, ORG, { permission: "audit:read" });
        if (!allowed) return wireError(403, "FORBIDDEN", "permission denied: audit:read", requestId);
        const action = url.searchParams.get("action") ?? undefined;
        const resourceId = url.searchParams.get("resourceId") ?? undefined;
        let items = [...stores.audit];
        if (action) items = items.filter((r) => r.action === action);
        if (resourceId) items = items.filter((r) => r.resourceId === resourceId);
        const res: auditLog.AuditLogPage = { items: items as unknown as auditLog.AuditRecord[], nextCursor: null };
        return jsonRes(200, res, { "x-dub-request-id": requestId });
      }
      return wireError(404, "NOT_FOUND", `no audit route ${url.pathname}`, requestId);
    },
  } as unknown as Fetcher;
}

// generic inert stub for services not under test (gantt/file-meta/drive/chat/...)
function inertStub(): Fetcher {
  return { fetch: async () => jsonRes(200, {}) } as unknown as Fetcher;
}

// ============================ harness assembly ============================
export interface Harness {
  stores: Stores;
  /** drive a request through the gateway (external edge). */
  gw(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<GwResult>;
  /** login via POST /api/v1/auth/test-login and return a bearer token. */
  login(user: TestUserKey): Promise<string>;
  users: typeof TEST_USERS;
}

export interface GwResult {
  status: number;
  json: <T = unknown>() => T;
  raw: unknown;
  requestId: string | null;
  headers: Headers;
}

export interface HarnessOptions {
  rateLimiter?: import("../../services/api-gateway/src/rate-limit").RateLimiter;
  /** replace SVC_NOTIFICATION with an always-failing binding (BFF partial-error test). */
  breakNotification?: boolean;
}

/** A binding that always throws — gateway maps transport failure to 502 upstream. */
function failingStub(): Fetcher {
  return { fetch: async () => { throw new Error("connection refused"); } } as unknown as Fetcher;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const stores: Stores = { audit: [], inbox: new Map(), tasks: new Map() };

  const identity = await buildIdentity(stores);
  const auth = buildAuth().fetcher;
  const event = buildEvent(identity, stores);
  const task = taskStub(stores);
  const notif = opts.breakNotification ? failingStub() : notificationStub(stores);
  const audit = auditStub(stores, identity);
  const deploy = buildDeploy(identity, stores);
  const inert = inertStub();

  const env: GatewayEnv = {
    SVC_AUTH: auth,
    SVC_IDENTITY: identity,
    SVC_EVENT: event,
    SVC_TASK: task,
    SVC_GANTT: inert,
    SVC_NOTIFICATION: notif,
    SVC_FILE_META: inert,
    SVC_DRIVE_PROXY: inert,
    SVC_CHAT: inert,
    SVC_DEPLOY: deploy,
    SVC_GITHUB_SYNC: inert,
    SVC_AUDIT_LOG: audit,
    SVC_WEBHOOK_INGEST: inert,
    GATEWAY_VERSION: "integration-test",
    ALLOWED_ORIGINS: "https://app.devhub.test,http://localhost:5173",
    DEFAULT_MAX_BODY_BYTES: "10485760",
    FILES_MAX_BODY_BYTES: "26214400",
  } as GatewayEnv;

  const noRl = {
    check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }),
  };
  const gatewayApp = createGatewayApp({ rateLimiter: opts.rateLimiter ?? noRl });

  const gw = async (
    method: string,
    path: string,
    o: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<GwResult> => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token) headers["authorization"] = `Bearer ${o.token}`;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const req = new Request(`https://api.devhub.test${path}`, {
      method,
      headers,
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
    const res = await gatewayApp.fetch(req, env, execCtx);
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return {
      status: res.status,
      raw: parsed,
      json: <T = unknown>() => parsed as T,
      requestId: res.headers.get("x-dub-request-id"),
      headers: res.headers,
    };
  };

  const login = async (user: TestUserKey): Promise<string> => {
    const res = await gw("POST", "/api/v1/auth/test-login", { body: { userId: TEST_USERS[user].userId } });
    if (res.status !== 200) throw new Error(`test-login failed for ${user}: ${res.status} ${JSON.stringify(res.raw)}`);
    return res.json<{ token: string }>().token;
  };

  return { stores, gw, login, users: TEST_USERS };
}
