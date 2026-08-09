// Shared test harness: an app over MemIdentityRepo, seeded with the default org +
// system roles, plus fake audit/revoker sinks the tests can introspect and fault-
// inject. Deterministic newId/now keep assertions stable.
import { common } from "@dub/types";
import type { auditLog } from "@dub/types";
import { errors } from "@dub/errors";
import { createApp } from "../src/app";
import { MemIdentityRepo } from "../src/repo/mem-repo";
import { seedReferenceData } from "../src/seed";
import type { AuditSink, Deps, RequestCtx, SessionRevoker } from "../src/deps";
import type { UserRow } from "../src/repo/types";

export class FakeAudit implements AuditSink {
  syncCalls: auditLog.AuditRecordInput[] = [];
  published: auditLog.AuditRecordInput[] = [];
  failSync = false;
  async logSync(input: auditLog.AuditRecordInput): Promise<void> {
    if (this.failSync) throw errors.upstreamUnavailable("audit-log");
    this.syncCalls.push(input);
  }
  async publish(input: auditLog.AuditRecordInput): Promise<void> {
    this.published.push(input);
  }
}

export class FakeRevoker implements SessionRevoker {
  calls: string[] = [];
  fail = false;
  async revokeUser(userId: string, _ctx: RequestCtx): Promise<void> {
    if (this.fail) throw errors.upstreamUnavailable("auth-service");
    this.calls.push(userId);
  }
}

export const ORG_ID = common.DUB_DEFAULT_ORG_ID;

export interface Harness {
  app: ReturnType<typeof createApp>;
  repo: MemIdentityRepo;
  audit: FakeAudit;
  revoker: FakeRevoker;
  deps: Deps;
  adminId: string;
  memberId: string;
  adminRoleId: string;
  memberRoleId: string;
}

export async function makeHarness(): Promise<Harness> {
  const repo = new MemIdentityRepo();
  const audit = new FakeAudit();
  const revoker = new FakeRevoker();
  let seq = 0;
  const newId = (p: string): string => `${p}_${String(++seq).padStart(6, "0")}`;
  const now = (): string => "2026-08-09T00:00:00.000Z";

  await seedReferenceData({ repo, now, newId }, ORG_ID);

  const adminRole = (await repo.getRoleByName(ORG_ID, "admin"))!;
  const memberRole = (await repo.getRoleByName(ORG_ID, "member"))!;

  const mkUser = (id: string, email: string, displayName: string): UserRow => ({
    id,
    orgId: ORG_ID,
    email,
    displayName,
    githubLogin: null,
    avatarUrl: null,
    status: "active",
    createdAt: now(),
    updatedAt: now(),
  });

  const adminId = "user_admin";
  const memberId = "user_member";
  await repo.createUser(mkUser(adminId, "admin@devhub.jp", "Admin"));
  await repo.createUser(mkUser(memberId, "member@devhub.jp", "Member"));
  await repo.createAssignment({ id: newId("ra"), userId: adminId, roleId: adminRole.id, orgId: ORG_ID, resourceType: null, resourceId: null, grantedBy: adminId, grantedAt: now() });
  await repo.createAssignment({ id: newId("ra"), userId: memberId, roleId: memberRole.id, orgId: ORG_ID, resourceType: null, resourceId: null, grantedBy: adminId, grantedAt: now() });

  const deps: Deps = { repo, audit, revoker, now, newId, defaultOrgId: ORG_ID };
  const app = createApp({ deps, defaultOrgId: ORG_ID });

  return { app, repo, audit, revoker, deps, adminId, memberId, adminRoleId: adminRole.id, memberRoleId: memberRole.id };
}

// request helpers
export function asUser(userId: string, init?: RequestInit): RequestInit {
  return { ...init, headers: { ...(init?.headers ?? {}), "x-dub-user-id": userId, "x-dub-request-id": "req_test" } };
}
export function internal(init?: RequestInit): RequestInit {
  return { ...init, headers: { ...(init?.headers ?? {}), "x-dub-internal": "1", "x-dub-request-id": "req_test" } };
}
export function jsonBody(userIdOrInternal: RequestInit, method: string, body: unknown): RequestInit {
  return {
    ...userIdOrInternal,
    method,
    headers: { ...(userIdOrInternal.headers ?? {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
