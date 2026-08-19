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

  // ── Realtime collaboration (presence + live data sync) ──────────────────────
  // GanttRoom DO namespace (one instance per eventId). Free-tier compatible
  // (SQLite-backed DO). Absent in unit tests -> the ws-ticket route / WS routing 503.
  GANTT_ROOM?: DurableObjectNamespace<GanttRoom>;
  // gantt self-owned HMAC secret for ws-tickets (Worker Secret in prod; dev fallback in code).
  WS_TICKET_SECRET?: string;
  // Absolute base for the ws-ticket doUrl (gateway-bypassing / DO-direct). ":id" -> eventId.
  GANTT_RT_DO_URL_BASE?: string;
  // Origin allow-list enforced by the GanttRoom DO (comma-separated).
  GANTT_RT_ALLOWED_ORIGINS?: string;
  // DEV-ONLY: when "1", index.ts serves an unauthenticated /dev-ws-ticket + /demo page so
  // the DO can be exercised with two browser tabs from `wrangler dev`. NEVER set in prod.
  GANTT_RT_DEV_TICKET?: string;
}

export const SERVICE_NAME = "gantt-service";
