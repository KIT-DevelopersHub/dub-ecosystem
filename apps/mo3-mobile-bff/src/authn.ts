// Entry authentication seam. MO3 is an entrypoint (theme6): it verifies the Bearer
// token once via auth-service, then propagates trusted x-dub-* headers downstream
// (the @dub/http client re-adds them). External x-dub-* is never trusted — the
// requestId is freshly minted per request and userId comes only from /verify.
import type { auth, identity } from "@dub/types";
import type { RequestContext } from "@dub/http";
import type { AuthClient } from "@dub/auth-client";

// Capability candidates surfaced to the client for UI gating (端末は authz を直叩き
// しない). Frozen PERMISSION_CATALOG keys only — mobile:* keys are not yet in the
// catalog (identity 8-5: no unilateral additions), so we expose the read/write set.
export const CAPABILITY_CANDIDATES: readonly identity.PermissionKey[] = [
  "event:read",
  "event:write",
  "task:read",
  "task:write",
];

export interface CapabilityScope {
  resourceType?: string;
  resourceId?: string;
}

export interface Authenticator {
  verify(ctx: RequestContext, token: string): Promise<auth.AuthVerifyResponse>;
  /** Resolve the caller's allowed capabilities (subset of CAPABILITY_CANDIDATES). */
  capabilities(ctx: RequestContext, userId: string, orgId: string, scope?: CapabilityScope): Promise<identity.PermissionKey[]>;
}

/** Production authenticator backed by @dub/auth-client (verify + /authz/check). */
export class DubAuthenticator implements Authenticator {
  constructor(private readonly ac: AuthClient) {}

  verify(ctx: RequestContext, token: string): Promise<auth.AuthVerifyResponse> {
    return this.ac.verify(ctx, token);
  }

  async capabilities(
    ctx: RequestContext,
    userId: string,
    orgId: string,
    scope?: CapabilityScope,
  ): Promise<identity.PermissionKey[]> {
    const checks: identity.AuthzQuery[] = CAPABILITY_CANDIDATES.map((permission) => ({
      permission,
      ...(scope?.resourceType ? { resourceType: scope.resourceType } : {}),
      ...(scope?.resourceId ? { resourceId: scope.resourceId } : {}),
    }));
    const res = await this.ac.checkPermissions(
      { subjectUserId: userId, orgId, checks },
      { requestId: ctx.requestId },
    );
    return CAPABILITY_CANDIDATES.filter((_, i) => res.decisions[i]?.allowed);
  }
}
