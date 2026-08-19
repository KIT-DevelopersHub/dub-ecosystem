// DTO short-lived cache (KV). Key `gantt:dto:<eventId>`, TTL 60s. Purge is
// idempotent (§4: naturally idempotent DELETE, no IdempotencyStore needed).
//
// BEST-EFFORT by contract: this is a 60s optimization, never a source of truth, so a
// KV failure must NEVER fail the request that touched it. Before, `put`/`purge` were
// unguarded `await`s — a KV write error (free-tier daily write/delete quota exhausted
// under heavy testing, or a transient KV hiccup) threw, and @dub/errors normalized the
// raw throw to INTERNAL/500. The concrete bug: a timeline bar move/resize's task write
// commits (task-service persists start_at/due_at + emits task.updated), but then the
// PATCH's inline `purge` — or the no-cache GET /gantt rebuild's `put` fired by the
// FE's post-write refetch — 500'd, so the FE showed "サーバーエラー…時間をおいて再試行"
// and rolled the bar back: the user saw "error + not saved" for a save that DID persist.
// Every op now swallows KV errors (logs a structured warning) and degrades to "no cache".
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
    async purge(eventId) {
      // Purge is a stale-entry eviction; the 60s TTL and the event-driven purge cover us
      // if this fails, so it must never fail the write that triggered it.
      try {
        await kv.delete(keyOf(eventId));
      } catch (err) {
        warnKvFailure("purge", eventId, err);
      }
    },
  };
}
