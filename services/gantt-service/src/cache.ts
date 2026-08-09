// DTO short-lived cache (KV). Key `gantt:dto:<eventId>`, TTL 60s. Purge is
// idempotent (§4: naturally idempotent DELETE, no IdempotencyStore needed).
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
    async purge(eventId) {
      await kv.delete(keyOf(eventId));
    },
  };
}
