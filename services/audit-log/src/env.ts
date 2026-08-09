import type { D1Database, R2Bucket, Fetcher } from "@cloudflare/workers-types";
import type { AuthClient } from "@dub/auth-client";
import type { RequestContext } from "@dub/http";
import type { AuthnContext } from "@dub/auth-client";

// Worker bindings (wrangler.toml). Deploy is out of scope for this unit.
export interface Env {
  DB: D1Database; // shared dub-core D1 (audit_ namespace only)
  AUDIT_ARCHIVE: R2Bucket; // R2 bucket for monthly NDJSON archive
  SVC_IDENTITY: Fetcher; // identity-roster Service Binding (authz/check)
}

// Hono per-request variables.
export interface Vars {
  dubCtx: RequestContext;
  authClient: AuthClient;
  authn: AuthnContext;
}

export type AppBindings = { Bindings: Env; Variables: Vars };
