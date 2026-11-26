// Daily delivery budget for the aggregated drain (#841).
//
// On 2026-11-25 the drain flushed a ~2-month outbox backlog in one day and pushed dub-core
// to 96% of the D1 Free plan's 100k rows-written/day. Each processed outbox row costs the
// outbox UPDATE plus the consumer's own writes (audit_logs INSERT + its indexes, notification
// fan-out, ...), so the drain caps how many rows it CLAIMS per UTC day. Rows beyond the cap
// simply stay `pending` (never expired, never failed) and drain on the following days.
//
// The window is the UTC day because that is when D1's daily usage resets (00:00 UTC =
// 09:00 JST). Normal traffic is ~100-300 rows/day across both outbox DBs, so the default
// leaves >10x headroom while bounding a backlog flush to a fraction of the free tier.
import type { DurableObjectStorage } from "@cloudflare/workers-types";

export const DEFAULT_DAILY_ROW_CAP = 3000;
export const DAILY_USAGE_KEY = "freeq:dailyUsage";

interface DailyUsage {
  day: string; // YYYY-MM-DD (UTC)
  used: number; // rows claimed by the drain on that day
}

/** UTC calendar day of `nowMs` — matches the D1 daily usage reset. */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Resolve the cap from the FREEQ_DAILY_ROW_CAP var. Unset / non-numeric / negative falls
 * back to the default (a typo must not silently remove the guard). "0" pauses delivery.
 */
export function parseDailyRowCap(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_ROW_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DAILY_ROW_CAP;
  return Math.floor(n);
}

type UsageStorage = Pick<DurableObjectStorage, "get" | "put">;

/** Rows already claimed today (0 when the stored day is not today). */
export async function usedToday(storage: UsageStorage, nowMs: number): Promise<number> {
  const u = await storage.get<DailyUsage>(DAILY_USAGE_KEY);
  return u && u.day === utcDay(nowMs) ? u.used : 0;
}

/** Remaining rows the drain may claim today under `cap`. */
export async function remainingToday(storage: UsageStorage, cap: number, nowMs: number): Promise<number> {
  return Math.max(0, cap - (await usedToday(storage, nowMs)));
}

/** Add `rows` to today's usage (resets on a new UTC day). */
export async function recordUsage(storage: UsageStorage, rows: number, nowMs: number): Promise<number> {
  const used = (await usedToday(storage, nowMs)) + rows;
  await storage.put<DailyUsage>(DAILY_USAGE_KEY, { day: utcDay(nowMs), used });
  return used;
}
