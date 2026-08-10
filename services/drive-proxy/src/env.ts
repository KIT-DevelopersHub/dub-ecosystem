// Worker bindings + parsed runtime config. The only D1 binding (`DB`) is drive-proxy's
// OWN watch-channel registry (channel lifecycle) — NOT Drive file metadata, which
// remains file-meta-service's source of truth (§3).
import type { KVNamespace, Queue, Fetcher, D1Database } from "@cloudflare/workers-types";
import type { DubEventEnvelope, AuditRecordEnvelopeV1 } from "@dub/events";

export interface Env {
  // Stores (§3): token cache + short-TTL response cache + rate counter.
  KV: KVNamespace;
  // Watch-channel registry (drive_watch_channels only). Optional so P0 wiring without
  // Drive-watch still builds; the watch routes 500 if it is absent.
  DB?: D1Database;
  // Producer queues.
  EVT_FILE_META: Queue<DubEventEnvelope>; // drive.file.* -> file-meta consumer
  AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1>; // write-op audit records
  // Service Bindings.
  SVC_IDENTITY: Fetcher; // identity-roster /authz/check
  // Secrets (never logged; §3 run-book).
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  GOOGLE_OAUTH_REFRESH_TOKEN: string;
  // Drive-watch channel token — the shared secret echoed back as X-Goog-Channel-Token
  // and verified by webhook-ingest (its DRIVE_WEBHOOK_TOKEN[_NEXT]). current + next for
  // rotation. Never persisted to D1 or logged.
  DRIVE_WEBHOOK_TOKEN?: string;
  DRIVE_WEBHOOK_TOKEN_NEXT?: string;
  // https callback the channel posts to (webhook-ingest google-drive ingress).
  DRIVE_WATCH_CALLBACK_URL?: string;
  // Tunable numbers (frozen semantics — §8-2 old#8).
  DRIVE_RATE_WINDOW_SECONDS?: string;
  DRIVE_RATE_SOFT_LIMIT?: string;
  DRIVE_CACHE_TTL_LIST_SECONDS?: string;
  DRIVE_CACHE_TTL_FILE_SECONDS?: string;
  DRIVE_CACHE_TTL_SHEET_SECONDS?: string;
  DRIVE_WATCH_TTL_SECONDS?: string;
}

export interface DriveConfig {
  rateWindowSeconds: number;
  rateSoftLimit: number;
  listTtlSeconds: number;
  fileTtlSeconds: number;
  sheetTtlSeconds: number;
  watchTtlSeconds: number;
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseConfig(env: Env): DriveConfig {
  return {
    rateWindowSeconds: num(env.DRIVE_RATE_WINDOW_SECONDS, 100),
    rateSoftLimit: num(env.DRIVE_RATE_SOFT_LIMIT, 500),
    listTtlSeconds: num(env.DRIVE_CACHE_TTL_LIST_SECONDS, 60),
    fileTtlSeconds: num(env.DRIVE_CACHE_TTL_FILE_SECONDS, 60),
    sheetTtlSeconds: num(env.DRIVE_CACHE_TTL_SHEET_SECONDS, 30),
    // Google Drive caps channel TTL to ~24h for files.watch; default to that.
    watchTtlSeconds: num(env.DRIVE_WATCH_TTL_SECONDS, 24 * 60 * 60),
  };
}
