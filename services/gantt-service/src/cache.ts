// DTO short-lived cache (KV). Key `gantt:dto:<eventId>`, TTL 60s.
//
// Purge is TTL-based, NOT an eager KV delete. On the Workers FREE plan a KV `delete`
// counts against the same 1,000/day "write" budget as a `put` (see usage-meter's
// cloudflare-graphql.ts: write+delete are summed into kv_writes_day). The eager
// delete-on-every-event purge was the dominant consumer of that budget: mutations
// arrive here via the freeq-drain (every ~5 min) as task.*/action.*/event.* envelopes,
// and each fired one KV delete — hundreds/day, most of them on keys the 60s TTL had
// already expired. Because a mutation only reaches gantt through that async pipeline
// (already ≥ minutes of latency), the 60s TTL bounds read-staleness *tighter* than the
// event delivery itself, so relying on TTL expiry gives equivalent freshness with zero
// write-class ops. `purge` therefore no-ops the KV delete; keys self-expire in ≤60s.
import type { KVNamespace } from "@cloudflare/workers-types";
import type { gantt, common } from "@dub/types";
import type { DtoCache } from "./ports";

const TTL_SECONDS = 60;
const keyOf = (eventId: common.EventId): string => `gantt:dto:${eventId}`;

export function createKvCache(kv: KVNamespace): DtoCache {
  return {
    async get(eventId) {
      const raw = await kv.get(keyOf(eventId));
      if (!raw) return null;
      try {
        return JSON.parse(raw) as gantt.GanttChartDTO;
      } catch {
        return null;
      }
    },
    async put(eventId, dto) {
      await kv.put(keyOf(eventId), JSON.stringify(dto), { expirationTtl: TTL_SECONDS });
    },
    // Intentionally no KV delete — freshness is handled by TTL_SECONDS expiry. See the
    // module header for why the eager delete was removed (free-tier write-budget storm).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async purge(_eventId) {
      /* no-op: TTL expiry supersedes eager invalidation on the free plan */
    },
  };
}
