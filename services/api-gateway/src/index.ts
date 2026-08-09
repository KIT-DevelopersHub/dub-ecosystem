// Worker entry. The gateway is the only external HTTP entrypoint (api.developershub.jp).
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { GatewayEnv } from "./env";
import { createApp } from "./app";

export type { GatewayEnv } from "./env";
export { createApp } from "./app";
export type { GatewayApp, CreateAppOptions } from "./app";

const app = createApp();

export default {
  fetch(request: Request, env: GatewayEnv, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};
