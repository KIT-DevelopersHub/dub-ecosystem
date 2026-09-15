// Worker bindings (wrangler.toml). Single-operator, loopback-origin app (ADR 0003):
// the shared-token auth belongs to a later phase, so COMMANDER_OPERATOR_TOKEN is
// OPTIONAL — when unset the API is open (local/dev/test); when set, mutating routes
// require a matching `x-commander-token` header. This is a forward-compatible hook,
// not the full auth story.
import type { D1Database } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database; // shared dub-core D1 (commander_ namespace only)
  COMMANDER_OPERATOR_TOKEN?: string; // optional operator token (see above)
}

export type AppBindings = { Bindings: Env };
