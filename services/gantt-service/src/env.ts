import type { D1Database, KVNamespace, Fetcher, Queue, DurableObjectNamespace } from "@cloudflare/workers-types";
import type { DubEventEnvelope } from "@dub/events";
import type { GanttRoom } from "./gantt-room-do";

export interface Env {
  DB: D1Database;
  GANTT_KV: KVNamespace;
  SVC_TASK: Fetcher;
  SVC_EVENT: Fetcher;
  SVC_IDENTITY: Fetcher;
  // consumer binding (inbound only; gantt is a read model and publishes nothing)
  EVT_GANTT?: Queue<DubEventEnvelope>;
  // ── Realtime (DO + WS) ──────────────────────────────────────────────────────
  // The gantt-owned GanttRoom Durable Object (one instance per event; WS fanout /
  // presence / ws-ticket verify). Optional: absent in local/preview ⇒ Noop publisher.
  GANTT_ROOM?: DurableObjectNamespace<GanttRoom>;
  // gantt self-owned HMAC secret the ws-ticket is signed/verified with (Worker Secret).
  WS_TICKET_SECRET?: string;
  // Absolute base for the ws-ticket doUrl (gateway-bypassing / DO-direct). ":id" is
  // replaced with the event id.
  GANTT_RT_DO_URL_BASE?: string;
  // Origin allow-list enforced by the GanttRoom DO (comma-separated).
  GANTT_RT_ALLOWED_ORIGINS?: string;
}

export const SERVICE_NAME = "gantt-service";
