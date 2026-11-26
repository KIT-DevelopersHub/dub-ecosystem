// When the DO alarm fires next (no Cron: the account's 5-cron cap is full).
// Default: once a day at 07:00 JST. In the 7 days before the event: every 3 hours.
const HOUR = 3_600_000;
const JST_OFFSET = 9 * HOUR;
export const FINAL_WEEK_MS = 7 * 24 * HOUR;
export const FINAL_WEEK_INTERVAL_MS = 3 * HOUR;
export const DAILY_HOUR_JST = 7;

export function nextDigestRunAt(nowMs: number, nextEventStartMs: number | null): number {
  if (nextEventStartMs !== null && nextEventStartMs > nowMs && nextEventStartMs - nowMs <= FINAL_WEEK_MS) {
    return nowMs + FINAL_WEEK_INTERVAL_MS;
  }
  const jst = new Date(nowMs + JST_OFFSET);
  const todayAt = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), DAILY_HOUR_JST) - JST_OFFSET;
  return todayAt > nowMs ? todayAt : todayAt + 24 * HOUR;
}
