// Worker bindings (wrangler.toml). Single-operator, loopback-origin app (ADR 0003): the one
// credential is a shared operator token, carried in `x-commander-token`.
//
// `COMMANDER_OPERATOR_TOKEN` is optional in the TYPE only because wrangler cannot guarantee a
// var is present. It is NOT optional in behaviour: `operatorGate` answers 503 for every
// protected route when it is unset, so a misconfigured deploy serves nothing instead of
// serving everything. (It previously read `if (expected && ...)` — "unset" meant "no
// authorization at all", which is the one failure mode a deploy accident actually produces.)
//
// `commander/dev-up.sh` generates the token once into `commander/.commander.env.local` and
// passes it to all three processes (service via `--var`, daemon via env, web via
// `VITE_COMMANDER_TOKEN`), so local dev is already configured; there is nothing to opt into.
import type { D1Database } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database; // shared dub-core D1 (commander_ namespace only)
  /** Shared operator token. Unset => every protected route 503s (see above). */
  COMMANDER_OPERATOR_TOKEN?: string;
  /**
   * Comma-separated exact browser origins allowed to read responses. Unset => loopback
   * origins only, which is what local dev needs. See `origins.ts`.
   */
  COMMANDER_ALLOWED_ORIGINS?: string;
}

export type AppBindings = { Bindings: Env };
