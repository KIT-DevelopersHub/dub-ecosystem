// Snapshot freshness. The collector runs once a day, so a snapshot older than two
// collection cycles means the loop has stopped (it silently did from 2026-09-21 until this
// check existed, and the dashboard kept showing the 09-17 numbers as if current).
// Pure and side-effect free (unit-tested).

/** Older than this = stale: two missed daily runs. */
export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

/** True when there is no snapshot at all, or the latest one is older than STALE_AFTER_MS.
 *  An unparseable timestamp counts as stale (it cannot vouch for freshness). */
export function isStale(capturedAt: string | null, now: Date): boolean {
  if (capturedAt === null) return true;
  const t = Date.parse(capturedAt);
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > STALE_AFTER_MS;
}
