// Upstream contract clients (event-service / identity-roster) + Authorizer seam.
// Production impls call Service Bindings via @dub/http; tests inject fakes.
import type { Fetcher } from "@cloudflare/workers-types";
import { createServiceClient, type RequestContext } from "@dub/http";
import { DubError, isDubError, CommonErrorCodes } from "@dub/errors";
import { createAuthClient } from "@dub/auth-client";
import type { event, identity, member, common } from "@dub/types";
import type { Principal } from "./principal";

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

// ---- member-service: login account → team memberships ----
// Resolves an identity (login) userId to the teamIds of the 運営メンバー linked to it.
// Powers 送る・受け取る self/other-team routing: the server (never the client) decides
// whether an issued request materialises immediately (self / same-team) or waits for the
// receiver's approval (other team). A login with no linked member (or no teams) → [].
export interface MemberClient {
  teamsOfUser(ctx: RequestContext, identityUserId: string): Promise<common.TeamId[]>;
}

export function createServiceBindingMemberClient(binding: Fetcher): MemberClient {
  const client = createServiceClient(binding, { service: "member-service", caller: "task-service" });
  return {
    async teamsOfUser(ctx, identityUserId) {
      try {
        const res = await client.get<member.MemberByIdentityResponse>(
          ctx,
          `/members/people/by-identity/${identityUserId}`,
        );
        return res.member?.teamIds ?? [];
      } catch (err) {
        // No member linked to this login ⇒ treat as "no teams" (not an error).
        if (isDubError(err) && err.status === 404) return [];
        throw err;
      }
    },
  };
}

// ---- Authorizer: task:* permission check ----
export interface Authorizer {
  /** Throws FORBIDDEN when the principal lacks the permission. */
  require(ctx: RequestContext, principal: Principal, permission: identity.PermissionKey): Promise<void>;
}

/**
 * Production authorizer: service principals are trusted internal callers (bypass);
 * user principals go through identity /authz/check via @dub/auth-client (TTL cache,
 * fail-closed). orgId resolves to the P0 single-org default.
 */
export function createIdentityAuthorizer(identityBinding: Fetcher, orgId: string): Authorizer {
  const authClient = createAuthClient({ identityBinding, serviceName: "task-service" });
  return {
    async require(ctx, principal, permission) {
      if (principal.kind === "service") return;
      const allowed = await authClient.hasPermission(
        principal.userId,
        orgId,
        { permission },
        { requestId: ctx.requestId },
      );
      if (!allowed) throw new DubError(CommonErrorCodes.FORBIDDEN, `permission denied: ${permission}`, { status: 403 });
    },
  };
}
