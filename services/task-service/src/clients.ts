// Upstream contract clients (event-service / identity-roster) + the permission-source seam.
// Production impls call Service Bindings via @dub/http; tests inject fakes.
import type { Fetcher } from "@cloudflare/workers-types";
import { createServiceClient, type RequestContext } from "@dub/http";
import { isDubError } from "@dub/errors";
import { createAuthClient } from "@dub/auth-client";
import type { PermissionGranter } from "@dub/policy-gate";
import type { event, identity } from "@dub/types";

// ---- event-service: eventId existence + archived state ----
export interface EventRef {
  archivedAt: string | null;
}
export interface EventClient {
  /** null = 404 (event not found). */
  getEvent(ctx: RequestContext, eventId: string): Promise<EventRef | null>;
}

export function createServiceBindingEventClient(binding: Fetcher): EventClient {
  const client = createServiceClient(binding, { service: "event-service", caller: "task-service" });
  return {
    async getEvent(ctx, eventId) {
      try {
        const res = await client.get<event.GetEventResponse>(ctx, `/events/${eventId}`);
        return { archivedAt: res.archivedAt };
      } catch (err) {
        if (isDubError(err) && err.status === 404) return null;
        throw err;
      }
    },
  };
}

// ---- identity-roster: assignee existence ----
export interface IdentityClient {
  userExists(ctx: RequestContext, userId: string): Promise<boolean>;
}

export function createServiceBindingIdentityClient(binding: Fetcher): IdentityClient {
  const client = createServiceClient(binding, { service: "identity-roster", caller: "task-service" });
  return {
    async userExists(ctx, userId) {
      try {
        await client.get<identity.IdentityUserDetail>(ctx, `/users/${userId}`);
        return true;
      } catch (err) {
        if (isDubError(err) && err.status === 404) return false;
        throw err;
      }
    },
  };
}

// ---- permission source: which of the requested keys does this user hold? ----
//
// The gate's `PermissionGranter` port (@dub/policy-gate), i.e. the SAME seam
// drive-share-service / file-meta use. It replaced the old `Authorizer.require(ctx,
// principal, key)` interface, which answered "may this principal do X?" — a decision that
// now belongs to `policyGate` + POLICY_TABLE alone. This port only reports facts.
//
// The service-principal trust decision deliberately does NOT live here (it is not a fact
// about a user): see `taskPolicyGate` in app.ts.
/**
 * Production granter: identity-roster `/authz/check` through @dub/auth-client, which batches
 * one round-trip per rule and holds decisions for identity's own TTL. Fail-closed — a
 * transport failure throws and surfaces as 5xx, never as "no decision, so allow".
 */
export function createIdentityGranter(identityBinding: Fetcher, orgId: string): PermissionGranter {
  const authClient = createAuthClient({ identityBinding, serviceName: "task-service" });
  return async (userId, _orgId, keys) => {
    if (keys.length === 0) return [];
    // orgId comes from AppConfig (the P0 single org), which is also what the gate is mounted
    // with, so the two can never disagree and the argument is redundant by construction.
    const res = await authClient.checkPermissions({
      subjectUserId: userId,
      orgId,
      checks: keys.map((permission) => ({ permission })),
    });
    return keys.filter((_, i) => res.decisions[i]?.allowed === true);
  };
}
