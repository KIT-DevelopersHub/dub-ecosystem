// identity-roster client (POST /users/provision). Invite-only: identity is the
// source of truth for who may log in and returns "rejected" for uninvited emails
// (theme2). The identity service itself is stubbed until the 9-x integration wave;
// this client speaks the frozen contract so it drops in unchanged.
import type { Fetcher } from "@cloudflare/workers-types";
import type { RequestContext } from "@dub/http";
import { createServiceClient } from "@dub/http";
import type { identity } from "@dub/types";

// ProvisionUserRequest is frozen in @dub/types; the response is not yet, so the
// expected shape is modelled locally (identity-roster owns the canonical version).
export type ProvisionStatus = "existing" | "provisioned" | "rejected";
export interface ProvisionResult {
  status: ProvisionStatus;
  user: identity.IdentityUser | null; // null when rejected
}

export interface IdentityClient {
  provision(ctx: RequestContext, input: identity.ProvisionUserRequest): Promise<ProvisionResult>;
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
}
