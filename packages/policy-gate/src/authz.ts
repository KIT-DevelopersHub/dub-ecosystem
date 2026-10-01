// The one production implementation of the gate's PermissionGranter port: identity-roster's
// POST /authz/check over a Service Binding. Services wire it in a single line, so none of
// them hand-rolls the wire call (and none can accidentally hand-roll an evaluator either —
// the decision stays in identity-roster/src/authz.ts).
import type { Fetcher } from "@cloudflare/workers-types";
import { createServiceClient, newRequestId } from "@dub/http";
import type { identity } from "@dub/types";
import type { PermissionGranter } from "./gate";

/** identity-roster caps one /authz/check at 20 queries (MAX_BATCH_CHECKS). */
const MAX_BATCH_CHECKS = 20;

export interface AuthzGranterOptions {
  /** Calling service name (correlation headers / identity logs). */
  caller: string;
  /** Propagate the inbound x-dub-request-id when the caller has it. */
  requestId?: string;
}

export function createAuthzGranter(binding: Fetcher, opts: AuthzGranterOptions): PermissionGranter {
  const client = createServiceClient(binding, { service: "identity-roster", caller: opts.caller });

  return async (userId, orgId, keys) => {
    const held: identity.PermissionKey[] = [];
    for (let i = 0; i < keys.length; i += MAX_BATCH_CHECKS) {
      const batch = keys.slice(i, i + MAX_BATCH_CHECKS);
      const req: identity.AuthzCheckRequest = {
        subjectUserId: userId,
        orgId,
        checks: batch.map((permission) => ({ permission })),
      };
      // Fail closed: a transport/upstream failure throws and becomes a 5xx. It must never
      // degrade into "no decision, so allow".
      const res = await client.post<identity.AuthzCheckResponse>(
        { requestId: opts.requestId ?? newRequestId() },
        "/authz/check",
        req,
      );
      batch.forEach((permission, j) => {
        if (res.decisions[j]?.allowed === true) held.push(permission);
      });
    }
    return held;
  };
}
