// commander-service Worker entry. HTTP only (no queue/cron). Deploy is out of scope
// for this unit (scaffold; wired into the gateway in a later phase).
import type { ExecutionContext } from "@cloudflare/workers-types";
import { createApp } from "./app";
import type { Env } from "./env";

const app = createApp();

const handler = {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(req, env, ctx as unknown as never);
  },
};

export default handler;
export { createApp };
export type { Env };
