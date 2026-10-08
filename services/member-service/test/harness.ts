// Test harness: builds AppDeps around the in-memory repo with an injectable fake
// PermissionGranter. Drives the real Hono app — @dub/policy-gate included — end to end
// without D1 / Service Bindings.
import type { PermissionGranter } from "@dub/policy-gate";
import type { common, identity } from "@dub/types";
import { policy } from "@dub/types";
import { createApp } from "../src/app";
import { InMemoryMemberRepo } from "../src/memory-repo";
import type { AppDeps } from "../src/types";

/**
 * The gate's PermissionGranter port over a fixed key set: it answers "which of these keys do
 * you hold?", exactly like identity's /authz/check. Nothing else is faked — authn (the
 * x-dub-user-id header), the x-dub-internal marker and the whole rule comparison are the
 * real policyGate running over the real POLICY_TABLE.
 */
export function fakeAuthz(granted: Set<identity.PermissionKey>): PermissionGranter {
  return async (_userId, _orgId, keys) => keys.filter((k) => granted.has(k));
}

/** The keys an "admin-like" test subject holds: the identity domain keys plus 編集 on every
 *  app this service hosts. Derived from the policy layer so a new app/level is picked up
 *  automatically instead of drifting from production grants. */
export function adminGrants(): Set<identity.PermissionKey> {
  return new Set<identity.PermissionKey>([
    "identity:read",
    "identity:admin",
    ...policy.keysForAppLevel("members", "edit"),
    ...policy.keysForAppLevel("participation", "edit"),
  ]);
}

let seq = 0;
export function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps & { repo: InMemoryMemberRepo } {
  const repo = new InMemoryMemberRepo();
  const deps: AppDeps = {
    repo,
    authz: fakeAuthz(adminGrants()),
    orgId: "org_devhub" as common.OrgId,
    now: () => "2026-08-12T00:00:00.000Z",
    newTeamId: () => `team_${String(seq++).padStart(6, "0")}`,
    newMemberId: () => `member_${String(seq++).padStart(6, "0")}`,
    newParticipationId: () => `part_${String(seq++).padStart(6, "0")}`,
    ...overrides,
  };
  return Object.assign(deps, { repo });
}

export interface CallInit {
  userId?: string | null; // null = omit header (unauthenticated)
  body?: unknown;
  internal?: boolean; // set x-dub-internal (genuine s2s call, e.g. /members/internal/*)
}

export async function call(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  init: CallInit = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "x-dub-request-id": "req_test" };
  if (init.userId !== null) headers["x-dub-user-id"] = init.userId ?? "user_caller";
  if (init.internal) headers["x-dub-internal"] = "1";
  const reqInit: RequestInit = { method, headers };
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    reqInit.body = JSON.stringify(init.body);
  }
  const res = await app.request(`http://svc${path}`, reqInit);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

export { createApp };
