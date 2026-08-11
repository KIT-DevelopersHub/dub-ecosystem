// identity-roster client. identity is the source of truth for who may log in and
// for the canonical user id + roles. Three seams are used by auth-service:
//   - provision      : mobile-exchange invite-only gate (theme2)
//   - lookupByEmail  : password-login allowlist (active roster email → user)
//   - getUser        : resolve a session/target userId → canonical email (password mgmt)
//   - hasPermission  : identity:admin gate for the admin password endpoints
// The identity service speaks the frozen contract so this client drops in unchanged.
import type { Fetcher } from "@cloudflare/workers-types";
import type { RequestContext } from "@dub/http";
import { createServiceClient } from "@dub/http";
import { common, type identity } from "@dub/types";

// ProvisionUserRequest is frozen in @dub/types; the response is not yet, so the
// expected shape is modelled locally (identity-roster owns the canonical version).
export type ProvisionStatus = "existing" | "provisioned" | "rejected";
export interface ProvisionResult {
  status: ProvisionStatus;
  user: identity.IdentityUser | null; // null when rejected
}

/** Roster lookup by email (read-only). user is null when the email is not on the roster. */
export interface LookupResult {
  user: identity.IdentityUser | null;
}

export interface IdentityClient {
  provision(ctx: RequestContext, input: identity.ProvisionUserRequest): Promise<ProvisionResult>;
  /** Login allowlist: resolve an email to its roster user (any status) or null. */
  lookupByEmail(ctx: RequestContext, email: string): Promise<LookupResult>;
  /** Resolve a userId to its canonical roster record; null when not found. */
  getUser(ctx: RequestContext, userId: string): Promise<identity.IdentityUser | null>;
  /** True when the user holds `permission` org-wide (used for identity:admin gates). */
  hasPermission(ctx: RequestContext, userId: string, permission: identity.PermissionKey): Promise<boolean>;
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; code?: string };
  return e.status === 404 || e.code === "NOT_FOUND";
}

export class ServiceBindingIdentityClient implements IdentityClient {
  private readonly client;
  constructor(binding: Fetcher, caller = "auth-service") {
    this.client = createServiceClient(binding, { service: "identity-roster", caller });
  }

  async provision(ctx: RequestContext, input: identity.ProvisionUserRequest): Promise<ProvisionResult> {
    return this.client.post<ProvisionResult, identity.ProvisionUserRequest>(ctx, "/users/provision", input, {
      idempotencyKey: `provision:${input.email}`,
    });
  }

  async lookupByEmail(ctx: RequestContext, email: string): Promise<LookupResult> {
    // GET-equivalent read; retryable via an idempotency key so a transient blip on
    // login does not fail-closed on the first attempt.
    return this.client.post<LookupResult, { email: string }>(ctx, "/internal/users/lookup", { email }, {
      idempotencyKey: `lookup:${email}`,
    });
  }

  async getUser(ctx: RequestContext, userId: string): Promise<identity.IdentityUser | null> {
    try {
      return await this.client.get<identity.IdentityUser>(ctx, `/users/${encodeURIComponent(userId)}`);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async hasPermission(ctx: RequestContext, userId: string, permission: identity.PermissionKey): Promise<boolean> {
    const res = await this.client.post<identity.AuthzCheckResponse, identity.AuthzCheckRequest>(ctx, "/authz/check", {
      subjectUserId: userId,
      orgId: common.DUB_DEFAULT_ORG_ID,
      checks: [{ permission }],
    });
    return res.decisions[0]?.allowed === true;
  }
}
