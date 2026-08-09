// Queue consumer for dub-q-evt-mobile-bff. MO3 subscribes to task.*/event.*/action.*
// (theme1) and appends the differential-sync change_log (mobile_change_log) from each
// event. The mapping + append store live in change-log.ts; this file only wires the
// consumer to the Worker's DB_MOBILE binding (mobile namespace). index.ts calls this
// from the Worker's queue() handler.
import type { MessageBatch } from "@cloudflare/workers-types";
import { createDbClient } from "@dub/db";
import type { DubEventEnvelope } from "@dub/events";
import type { Env } from "./env";
import { D1ChangeLogStore, createChangeLogConsumer } from "./change-log";

export async function mobileQueueHandler(batch: MessageBatch<DubEventEnvelope>, env: Env): Promise<void> {
  const db = createDbClient(env.DB_MOBILE, { namespace: "mobile" });
  const consumer = createChangeLogConsumer(new D1ChangeLogStore(db));
  await consumer(batch, env);
}
