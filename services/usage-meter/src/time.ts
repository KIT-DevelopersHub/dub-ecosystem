// UTC time helpers. All usage windows are computed in UTC to match Cloudflare's
// GraphQL Analytics (which buckets by UTC date) and to give a stable capture_day key.

/** "YYYY-MM-DD" (UTC) — the capture_day partition key and CF `date` filter value. */
export function utcDayString(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Start of the current UTC day (00:00:00.000Z). */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Start of the current UTC month (day 1, 00:00:00.000Z). */
export function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Next UTC midnight (when a daily quota resets). */
export function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** First moment of next UTC month (when a monthly quota resets). */
export function firstOfNextUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
