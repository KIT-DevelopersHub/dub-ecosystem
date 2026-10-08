import type { D1Database, R2Bucket, Fetcher } from "@cloudflare/workers-types";
import type { RequestContext } from "@dub/http";
import type { PolicyGateVars } from "@dub/policy-gate";

// Worker bindings (wrangler.toml). Deploy is out of scope for this unit.
export interface Env {
  DB: D1Database; // shared dub-core D1 (audit_ namespace only)
  // R2 bucket for the monthly NDJSON archive. Optional: absent on the Workers FREE plan
  // (wrangler.free.toml binds no R2), in which case the scheduled handler skips archiving.
  AUDIT_ARCHIVE?: R2Bucket;
  SVC_IDENTITY: Fetcher; // identity-roster Service Binding (authz/check)
}

// Hono per-request variables. `userId` is inherited from PolicyGateVars: @dub/policy-gate
// establishes the actor and publishes it, so nothing downstream re-reads the trusted header.
export interface Vars extends PolicyGateVars {
  dubCtx: RequestContext;
}

export type AppBindings = { Bindings: Env; Variables: Vars };
