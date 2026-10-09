// Cross-service smoke "world": one seeded node:sqlite D1 shared by the REAL Hono
// apps / repos of event-service, task-service, notification and mail-gateway, wired
// with small in-process fakes for the seams that would otherwise need the Cloudflare
// runtime (authz, service bindings, Queues, mail provider). Every leg that has domain
// substance runs the service's own code + SQL; only transport is faked. Owns only
// packages/e2e-smoke.
import type { Fetcher, Queue } from "@cloudflare/workers-types";
import { createDbClient, newId, nowIso, type DbClient } from "@dub/db";
import { common } from "@dub/types";
import type { DubEventEnvelope, AuditRecordEnvelopeV1 } from "@dub/events";
import { createAuthzGranter, type PermissionGranter } from "@dub/policy-gate";

import {
  createApp as createEventApp,
  createD1EventRepo,
  type AppDeps as EventDeps,
} from "../../../services/event-service/src/index";
import type { ScopedAuthz } from "../../../services/event-service/src/types";
import { buildApp as buildTaskApp } from "../../../services/task-service/src/app";
import { createD1TaskRepo } from "../../../services/task-service/src/repo";
import type { Deps as TaskDeps } from "../../../services/task-service/src/deps";
import type { AppConfig } from "../../../services/task-service/src/env";
import { MockMailProvider } from "../../../services/mail-gateway/src/provider";
import type { SendDeps } from "../../../services/mail-gateway/src/types";
import { createApp as createIdentityApp } from "../../../services/identity-roster/src/app";
import { D1IdentityRepo } from "../../../services/identity-roster/src/repo/d1-repo";
import { seedReferenceData } from "../../../services/identity-roster/src/seed";
import { createApp as createMemberApp } from "../../../services/member-service/src/app";
import { createD1MemberRepo } from "../../../services/member-service/src/d1-repo";

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

/**
 * THE authz seam for every policy-gated service in this world (event-service and
 * task-service today). Their authorization is POLICY_TABLE enforced by @dub/policy-gate, so
 * the seam is the `PermissionGranter` port — a FUNCTION, not the old `Authorizer` object:
 * grant every key asked for. The smoke world exercises cross-service domain flows, not RBAC
 * (which each service's own test/policy-table.test.ts owns), and the gate still enforces the
 * x-dub-user-id contract the old `requireAuth` middleware did.
 *
 * One granter for all of them on purpose: a per-service copy is how task-service's seam went
 * stale (an `{ require }` object survived the migration and TypeError'd every write into a
 * 500) while event-service's was updated.
 */
function allowGranter(): PermissionGranter {
  return async (_userId, _orgId, keys) => [...keys];
}

/** Layer 2 seam: the body-dependent, event-scoped `event:admin` demand. Always allow. */
function allowScopedAuthz(): ScopedAuthz {
  return { hasPermission: async () => true };
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
    authz: allowGranter(),
    scopedAuthz: allowScopedAuthz(),
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
    authz: allowGranter(),
    // Genuine cross-service ref: the event existence gate reads the REAL event row.
    eventClient: {
      getEvent: async (_ctx, id) => {
        const ev = await eventRepo.getEvent(id);
        return ev ? { archivedAt: ev.archivedAt } : null;
      },
    },
    identity: { userExists: async () => true },
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

// ── Authz-boundary world ─────────────────────────────────────────────────────
// The world above grants every key (`allowGranter`), so no test built on it can observe
// an authorization boundary. This one swaps that seam for the PRODUCTION decision path:
// the services' policyGate -> `createAuthzGranter` (the exact granter their Worker entry
// wires via sharedAuthzGranter) -> identity-roster's REAL `POST /authz/check` -> its
// RBAC evaluator over the identity_* rows in the same seeded D1. The only fake is the
// Service Binding itself (a Fetcher that calls identity's Hono app in-process).

export const OTHER_ORG = "org_other";

/** Seeded principals. Ids are opaque; only the role/org each one holds matters. */
export const PRINCIPALS = {
  /** org_devhub, system `admin` role. */
  admin: "usr_admin000000000000000000",
  /** org_devhub, system `member` role (identity:read, no drive / members-edit keys). */
  member: "usr_member00000000000000000",
  /** org_devhub, active, holding a custom role with ZERO permissions. */
  noKeys: "usr_nokeys00000000000000000",
  /** org_other, that org's own `admin` role — powerful, but in the wrong org. */
  otherAdmin: "usr_otheradmin0000000000000",
} as const;

/** org_other data planted straight into D1. No response to an org_devhub caller may
 *  contain any of these strings (see `expectNoLeak` in the boundary suite). */
export const OTHER_ORG_SECRETS = {
  userEmail: "secret-admin@other-org.test",
  userName: "OtherOrgSecretAdmin",
  teamId: "team_otherorg000000000000",
  teamName: "OtherOrgSecretTeam",
  personId: "member_otherorg0000000000",
  personName: "OtherOrgSecretPerson",
} as const;

export interface AuthzWorld {
  raw: ReturnType<typeof makeSeededD1>["raw"];
  identityApp: ReturnType<typeof createIdentityApp>;
  memberApp: ReturnType<typeof createMemberApp>;
  /** Paths the services called on identity over the binding, in order. */
  identityCalls: string[];
}

export async function createAuthzWorld(): Promise<AuthzWorld> {
  const { d1, raw } = makeSeededD1();
  const now = () => "2026-10-10T00:00:00.000Z";
  let seq = 0;
  const mkId = (p: string) => `${p}_${String(++seq).padStart(6, "0")}`;

  // ---- identity-roster: REAL app + REAL D1 repo; the decision point ----
  const identityRepo = new D1IdentityRepo(createDbClient(d1, { namespace: "identity" }));
  const identityApp = createIdentityApp({
    deps: {
      repo: identityRepo,
      audit: { logSync: async () => {}, publish: async () => {} },
      revoker: { revokeUser: async () => {} },
      now,
      newId: mkId,
      defaultOrgId: ORG,
    },
    defaultOrgId: ORG,
  });

  // org_devhub + its system roles come from the physical migrations; org_other is seeded
  // with the same reference data so its `admin` is a real, fully-keyed role — in org_other.
  await seedReferenceData({ repo: identityRepo, now, newId: mkId }, OTHER_ORG, "Other Org");
  await identityRepo.createRole({
    id: "role_nokeys", orgId: ORG, name: "nokeys", isSystem: false, permissions: [], createdAt: now(), updatedAt: now(),
  });
  const user = async (id: string, orgId: string, email: string, displayName: string, roleName: string) => {
    await identityRepo.createUser({
      id, orgId, email, displayName, furigana: null, githubLogin: null, avatarUrl: null,
      status: "active", source: "manual", createdAt: now(), updatedAt: now(),
    });
    const role = (await identityRepo.getRoleByName(orgId, roleName))!;
    await identityRepo.createAssignment({
      id: mkId("ra"), userId: id, roleId: role.id, orgId, resourceType: null, resourceId: null, grantedBy: id, grantedAt: now(),
    });
  };
  await user(PRINCIPALS.admin, ORG, "admin@devhub.test", "DevhubAdmin", "admin");
  await user(PRINCIPALS.member, ORG, "member@devhub.test", "DevhubMember", "member");
  await user(PRINCIPALS.noKeys, ORG, "nokeys@devhub.test", "DevhubNoKeys", "nokeys");
  await user(PRINCIPALS.otherAdmin, OTHER_ORG, OTHER_ORG_SECRETS.userEmail, OTHER_ORG_SECRETS.userName, "admin");

  // ---- the Service Binding seam: an in-process Fetcher onto identity's app ----
  const identityCalls: string[] = [];
  const identityBinding = {
    fetch: async (req: Request) => {
      identityCalls.push(`${req.method} ${new URL(req.url).pathname}`);
      return identityApp.request(req);
    },
  } as unknown as Fetcher;
  // Production granter, fresh cache per world (createAuthzGranter's default).
  const granter = (caller: string) => createAuthzGranter(identityBinding, { caller });

  // ---- member-service: REAL app + REAL D1 repo ----
  const memberApp = createMemberApp({
    repo: createD1MemberRepo(createDbClient(d1, { namespace: "member" })),
    authz: granter("member-service"),
    orgId: ORG as common.OrgId,
    now,
    newTeamId: () => mkId("team"),
    newMemberId: () => mkId("member"),
    newParticipationId: () => mkId("part"),
  });

  // ---- org_other rows planted directly in the shared D1 (never via an API) ----
  const s = OTHER_ORG_SECRETS;
  raw.prepare(
    "INSERT INTO member_teams (id, org_id, key, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(s.teamId, OTHER_ORG, "secret", s.teamName, 1000, now(), now());
  raw.prepare(
    `INSERT INTO member_people (id, org_id, name, status, identity_user_id, sort_order, version, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'added', ?, 1000, 1, ?, ?, ?)`,
  ).run(s.personId, OTHER_ORG, s.personName, PRINCIPALS.otherAdmin, PRINCIPALS.otherAdmin, now(), now());


  return { raw, identityApp, memberApp, identityCalls };
}

export interface CallResult {
  status: number;
  json: any;
  /** The raw response body, byte for byte — what a leak assertion must scan. */
  text: string;
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
  init: { userId?: string; body?: unknown; query?: Record<string, string>; internal?: boolean } = {},
): Promise<CallResult> {
  const url = new URL(`http://svc${path}`);
  if (init.query) for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { "x-dub-request-id": "req_smoke" };
  if (init.userId) headers["x-dub-user-id"] = init.userId;
  if (init.internal) headers["x-dub-internal"] = "1";
  const reqInit: RequestInit = { method, headers };
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    reqInit.body = JSON.stringify(init.body);
  }
  const res = await app.request(url.toString(), reqInit);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}
