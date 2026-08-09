// gantt-service Worker entry: HTTP (Hono app) + Queue consumer (cache purge).
// The `as never` bridges reconcile Hono's Fetch-standard types with
// @cloudflare/workers-types at the runtime boundary only.
import type { ExportedHandler, MessageBatch } from "@cloudflare/workers-types";
import type { DubEventEnvelope } from "@dub/events";
import type { Env } from "./env";
import { createApp } from "./app";
import { buildQueueConsumer } from "./queue";

const app = createApp();

const handler: ExportedHandler<Env> = {
  fetch(request, env, ctx) {
    return app.fetch(request as never, env, ctx as never) as never;
  },
  async queue(batch, env) {
    await buildQueueConsumer(env)(batch as unknown as MessageBatch<DubEventEnvelope>, env);
  },
};

export default handler;
export { createApp } from "./app";
export { buildGanttChartDTO, progressOf } from "./dto";
