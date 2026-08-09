// Cloudflare Worker entry. One physical Worker per service (theme7). The app is
// rebuilt per request from bindings — buildDeps is cheap and keeps the isolate
// free of shared mutable state.
import type { ExecutionContext } from "@cloudflare/workers-types";
import { buildApp } from "./app";
import { buildDeps } from "./deps";
import type { Env } from "./env";

export type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const app = buildApp(buildDeps(env));
    return app.fetch(request);
  },
};
