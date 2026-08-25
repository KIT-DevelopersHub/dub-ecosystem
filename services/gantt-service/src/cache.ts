// DTO short-lived cache (KV). Key `gantt:dto:<eventId>`, TTL 60s.
//
// BEST-EFFORT by contract (#359/#376): this is a 60s optimization, never a source of
// truth, so a KV failure must NEVER fail the request that touched it. `get`/`put` swallow
// KV errors (log a structured warning) and degrade to "no cache". Before, an unguarded
// put/purge could throw when the free-tier daily KV write quota was exhausted under heavy
// testing, and @dub/errors normalized that raw throw to INTERNAL/500 — so a timeline bar
// move/resize showed "サーバーエラー…時間をおいて再試行" and rolled the bar back for a
// save that DID persist.
//
// Purge is TTL-based, NOT an eager KV delete (#399). On the Workers FREE plan a KV
// `delete` counts against the same 1,000/day write budget as a `put`; the eager
// delete-on-every-event purge was the dominant consumer of it. A mutation only reaches
// gantt via the freeq-drain (~5 min latency), so the 60s TTL already bounds read-staleness
// tighter than event delivery — TTL expiry gives equivalent freshness with zero
// write-class ops. `purge` therefore no-ops; keys self-expire in ≤60s.
import type { KVNamespace } from "@cloudflare/workers-types";
import type { gantt, common } from "@dub/types";
import type { DtoCache } from "./ports";
import { SERVICE_NAME } from "./env";

const TTL_SECONDS = 60;
const keyOf = (eventId: common.EventId): string => `gantt:dto:${eventId}`;

/** Structured warning for a swallowed KV failure ([observability] captures console). */
function warnKvFailure(op: "get" | "put" | "purge", eventId: common.EventId, err: unknown): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      service: SERVICE_NAME,
      event: "gantt.cache.kv_failed",
      message: `KV ${op} failed; degrading to no-cache (best-effort)`,
      op,
      eventId,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

export function createKvCache(kv: KVNamespace): DtoCache {
  return {
    async get(eventId) {
      let raw: string | null;
      try {
        raw = await kv.get(keyOf(eventId));
      } catch (err) {
        // A read miss is safe — the caller rebuilds the DTO from upstream.
        warnKvFailure("get", eventId, err);
        return null;
      }
      if (!raw) return null;
      try {
        return JSON.parse(raw) as gantt.GanttChartDTO;
      } catch {
        return null;
      }
    },
    async put(eventId, dto) {
      // Caching the fresh DTO is an optimization; a failure just means the next read
      // rebuilds. It must never fail the GET (nor the no-cache refetch after a write).
      try {
        await kv.put(keyOf(eventId), JSON.stringify(dto), { expirationTtl: TTL_SECONDS });
      } catch (err) {
        warnKvFailure("put", eventId, err);
      }
    },
    // Intentionally no KV delete — freshness is handled by TTL_SECONDS expiry (#399). See
    // the module header for why the eager delete was removed (free-tier write-budget storm).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async purge(_eventId) {
      /* no-op: TTL expiry supersedes eager invalidation on the free plan */
    },
  };
}
