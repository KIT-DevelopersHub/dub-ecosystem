// Worker entrypoint. Wires the runtime env (D1, identity Service Binding) into AppDeps.
import type { ExecutionContext } from "@cloudflare/workers-types";
import { createApp } from "./app";
import { buildDeps } from "./deps";
import type { Env } from "./env";

export type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const requestId = request.headers.get("x-dub-request-id") ?? undefined;
    const app = createApp(buildDeps(env, requestId));
    return app.fetch(request as unknown as Request) as unknown as Response;
  },
};

export { createApp } from "./app";
export { createD1LpRepo } from "./d1-repo";
export { InMemoryLpRepo } from "./memory-repo";
