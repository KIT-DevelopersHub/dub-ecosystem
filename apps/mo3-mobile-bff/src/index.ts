// Cloudflare Worker entry. One physical Worker per unit (theme7). The app is
// rebuilt per request from bindings (buildDeps is cheap, keeps the isolate free of
// shared mutable state). queue() drains dub-q-evt-mobile-bff (STUB no-op in P0).
import type { ExecutionContext, MessageBatch } from "@cloudflare/workers-types";
import type { DubEventEnvelope } from "@dub/events";
import { buildApp } from "./app";
import { buildDeps } from "./deps";
import { mobileQueueHandler } from "./queue";
import type { Env } from "./env";

export type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const app = buildApp(buildDeps(env));
    return app.fetch(request);
  },
  async queue(batch: MessageBatch<DubEventEnvelope>, env: Env): Promise<void> {
    await mobileQueueHandler(batch, env);
  },
};
