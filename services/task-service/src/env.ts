// Worker bindings + derived runtime config for task-service.
// Shared dub-core D1 (task_* namespace) + Queue producers/consumer + SB deps.
import type { D1Database, Queue, Fetcher } from "@cloudflare/workers-types";
import type { DubEventEnvelope, AuditRecordEnvelopeV1 } from "@dub/events";
import { common } from "@dub/types";

export interface Env {
  // --- data ---
  DB: D1Database; // shared dub-core; DbClient enforces task_* namespace

  // --- Queue producers (task.* fan-out; keyed by @dub/events CONSUMER_QUEUE_BINDINGS) ---
  EVT_NOTIFICATION?: Queue<DubEventEnvelope>;
  EVT_GITHUB_SYNC?: Queue<DubEventEnvelope>;
  EVT_GANTT?: Queue<DubEventEnvelope>;
  EVT_MOBILE_BFF?: Queue<DubEventEnvelope>;
  EVT_FILE_META?: Queue<DubEventEnvelope>;
  AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1>; // publishAudit channel (theme13)

  // --- service bindings ---
  SVC_IDENTITY: Fetcher; // identity-roster (POST /authz/check, GET /users/:id)
  SVC_EVENT: Fetcher; // event-service (GET /events/:id)

  // --- vars ---
  ENVIRONMENT?: string; // "local" | "preview" | "production"
  DUE_SOON_WINDOW_HOURS?: string; // default 24 (frozen with notification)
  SERVICE_CALLERS?: string; // comma-separated x-dub-caller allowlist for service role
  DUB_DEFAULT_ORG_ID?: string; // P0 single-org fallback (theme; auth-client uses same)
}

const DEFAULTS = {
  dueSoonWindowHours: 24,
  serviceCallers: ["github-sync"],
} as const;

export interface AppConfig {
  environment: string;
  orgId: string;
  dueSoonWindowMs: number;
  serviceCallers: ReadonlySet<string>;
}

function intVar(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function configFromEnv(env: Env): AppConfig {
  const callers = (env.SERVICE_CALLERS ?? DEFAULTS.serviceCallers.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    environment: env.ENVIRONMENT ?? "production",
    orgId: env.DUB_DEFAULT_ORG_ID ?? common.DUB_DEFAULT_ORG_ID,
    dueSoonWindowMs: intVar(env.DUE_SOON_WINDOW_HOURS, DEFAULTS.dueSoonWindowHours) * 60 * 60 * 1000,
    serviceCallers: new Set(callers),
  };
}
