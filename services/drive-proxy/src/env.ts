// Worker bindings + parsed runtime config. drive-proxy owns NO D1 (no `DB`).
import type { KVNamespace, Queue, Fetcher } from "@cloudflare/workers-types";
import type { DubEventEnvelope, AuditRecordEnvelopeV1 } from "@dub/events";

export interface Env {
  // Stores (§3): token cache + short-TTL response cache + rate counter.
  KV: KVNamespace;
  // Producer queues.
  EVT_FILE_META: Queue<DubEventEnvelope>; // drive.file.* -> file-meta consumer
  AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1>; // write-op audit records
  // Service Bindings.
  SVC_IDENTITY: Fetcher; // identity-roster /authz/check
  // Secrets (never logged; §3 run-book).
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  GOOGLE_OAUTH_REFRESH_TOKEN: string;
  // Tunable numbers (frozen semantics — §8-2 old#8).
  DRIVE_RATE_WINDOW_SECONDS?: string;
  DRIVE_RATE_SOFT_LIMIT?: string;
  DRIVE_CACHE_TTL_LIST_SECONDS?: string;
  DRIVE_CACHE_TTL_FILE_SECONDS?: string;
  DRIVE_CACHE_TTL_SHEET_SECONDS?: string;
}

export interface DriveConfig {
  rateWindowSeconds: number;
  rateSoftLimit: number;
  listTtlSeconds: number;
  fileTtlSeconds: number;
  sheetTtlSeconds: number;
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
  };
}
