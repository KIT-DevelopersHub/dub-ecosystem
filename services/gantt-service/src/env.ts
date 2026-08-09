import type { D1Database, KVNamespace, Fetcher, Queue } from "@cloudflare/workers-types";
import type { DubEventEnvelope } from "@dub/events";

export interface Env {
  DB: D1Database;
  GANTT_KV: KVNamespace;
  SVC_TASK: Fetcher;
  SVC_EVENT: Fetcher;
  SVC_IDENTITY: Fetcher;
  // consumer binding (inbound only; gantt is a read model and publishes nothing)
  EVT_GANTT?: Queue<DubEventEnvelope>;
}

export const SERVICE_NAME = "gantt-service";
