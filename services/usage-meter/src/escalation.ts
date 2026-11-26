// Escalation levels + exhaustion projection (#902). Pure and side-effect free.
//
// `status` (ok/warn/critical at 70/90) stays as the frozen wire field. `level` adds the
// decision ladder used by the GitHub Issue flow and the dashboard:
//   warn     >= 70%  look at it: an Issue (P1) is opened so it is tracked
//   act      >= 85%  apply a mitigation from the playbook now (P1)
//   critical >= 95%  the service is about to stop: mitigate or decide to pay today (P0)
// The projection can raise the level: a window metric whose current pace reaches 100% before
// its reset is at least "warn" even below 70%, and a storage metric that fills within 7 days
// is at least "act".
import { DAY_MS, firstOfNextUtcMonth, nextUtcDay, startOfUtcDay, startOfUtcMonth } from "./time";
import type { MetricDef } from "./limits";

export type EscalationLevel = "ok" | "warn" | "act" | "critical" | "unknown";

export const LEVEL_PCT = { warn: 70, act: 85, critical: 95 } as const;

const RANK: Record<EscalationLevel, number> = { unknown: 0, ok: 1, warn: 2, act: 3, critical: 4 };

export function levelRank(level: EscalationLevel): number {
  return RANK[level];
}

export function maxLevel(a: EscalationLevel, b: EscalationLevel): EscalationLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Levels that open/update a tracked Issue. */
export function isEscalated(level: EscalationLevel): boolean {
  return level === "warn" || level === "act" || level === "critical";
}

export const LEVEL_LABEL: Record<EscalationLevel, string> = {
  ok: "余裕あり",
  warn: "注意",
  act: "対策",
  critical: "危険",
  unknown: "取得不可",
};

/** How a metric's run-out time is estimated.
 *  window = usage accumulates inside a daily/monthly window (pace since the window opened).
 *  growth = a stored total (D1/R2 bytes) that never resets (day-over-day growth).
 *  null   = no meaningful projection (per-minute peaks). */
export type ProjectionBasis = "window" | "growth";

export interface UsageProjection {
  basis: ProjectionBasis;
  /** When the ceiling is reached at the current pace; null = not before the reset (window)
   *  or not within a year / not growing (growth). Equal to the capture time when already over. */
  exhaustsAt: string | null;
  /** Window basis: projected % at the reset if the pace holds. Growth basis: null. */
  pctAtReset: number | null;
  /** Current pace in the metric's unit per day. */
  perDay: number;
}

export function projectionBasis(def: Pick<MetricDef, "metricKey" | "reset">): ProjectionBasis | null {
  if (def.metricKey.endsWith("_storage")) return "growth";
  if (def.metricKey.includes("peak")) return null;
  return def.reset === "none" ? "growth" : "window";
}

/** Below this much elapsed window the pace is too noisy to extrapolate. */
const MIN_ELAPSED_MS = { daily: 3 * 60 * 60 * 1000, monthly: 2 * DAY_MS } as const;
const GROWTH_HORIZON_MS = 365 * DAY_MS;

export interface HistoryPoint {
  day: string; // YYYY-MM-DD
  used: number;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function projectUsage(
  def: Pick<MetricDef, "metricKey" | "reset" | "limit">,
  used: number | null,
  capturedAt: Date,
  history: readonly HistoryPoint[] = [],
): UsageProjection | null {
  if (used === null || !Number.isFinite(used) || def.limit <= 0) return null;
  const basis = projectionBasis(def);
  const at = capturedAt.getTime();
  if (basis === "window") {
    if (def.reset !== "daily" && def.reset !== "monthly") return null;
    const start = (def.reset === "daily" ? startOfUtcDay(capturedAt) : startOfUtcMonth(capturedAt)).getTime();
    const end = (def.reset === "daily" ? nextUtcDay(capturedAt) : firstOfNextUtcMonth(capturedAt)).getTime();
    const elapsed = at - start;
    if (used >= def.limit) {
      return { basis, exhaustsAt: capturedAt.toISOString(), pctAtReset: round1((used / def.limit) * 100 * ((end - start) / Math.max(elapsed, 1))), perDay: (used / Math.max(elapsed, 1)) * DAY_MS };
    }
    if (elapsed < MIN_ELAPSED_MS[def.reset]) return null;
    const perMs = used / elapsed;
    const pctAtReset = round1(((perMs * (end - start)) / def.limit) * 100);
    const exhaustMs = perMs > 0 ? start + def.limit / perMs : Number.POSITIVE_INFINITY;
    return {
      basis,
      exhaustsAt: exhaustMs < end ? new Date(exhaustMs).toISOString() : null,
      pctAtReset,
      perDay: perMs * DAY_MS,
    };
  }
  if (basis === "growth") {
    if (used >= def.limit) return { basis, exhaustsAt: capturedAt.toISOString(), pctAtReset: null, perDay: 0 };
    const today = capturedAt.toISOString().slice(0, 10);
    const older = history
      .filter((h) => h.day < today && Number.isFinite(h.used))
      .sort((a, b) => (a.day < b.day ? -1 : 1));
    const first = older[0];
    if (!first) return null;
    const days = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${first.day}T00:00:00Z`)) / DAY_MS;
    if (days <= 0) return null;
    const perDay = (used - first.used) / days;
    if (perDay <= 0) return { basis, exhaustsAt: null, pctAtReset: null, perDay };
    const exhaustMs = at + ((def.limit - used) / perDay) * DAY_MS;
    return {
      basis,
      exhaustsAt: exhaustMs - at <= GROWTH_HORIZON_MS ? new Date(exhaustMs).toISOString() : null,
      pctAtReset: null,
      perDay,
    };
  }
  return null;
}

/** Level from the current % and (optionally) the projection. */
export function levelFor(pct: number | null, projection: UsageProjection | null, capturedAt: Date): EscalationLevel {
  if (pct === null || !Number.isFinite(pct)) return "unknown";
  let level: EscalationLevel =
    pct >= LEVEL_PCT.critical ? "critical" : pct >= LEVEL_PCT.act ? "act" : pct >= LEVEL_PCT.warn ? "warn" : "ok";
  if (projection?.exhaustsAt) {
    if (projection.basis === "window") {
      level = maxLevel(level, "warn");
    } else {
      const left = Date.parse(projection.exhaustsAt) - capturedAt.getTime();
      if (left <= 7 * DAY_MS) level = maxLevel(level, "act");
      else if (left <= 30 * DAY_MS) level = maxLevel(level, "warn");
    }
  }
  return level;
}

/** Why the level is what it is — one Japanese line for the Issue / mail. */
export function levelReason(pct: number | null, projection: UsageProjection | null): string {
  if (pct === null) return "使用量を取得できていません";
  const parts = [`現在 ${pct}%`];
  if (projection?.basis === "window" && projection.pctAtReset !== null) {
    parts.push(
      projection.exhaustsAt
        ? `このペースだとリセット前に上限 (リセット時 ${projection.pctAtReset}% 見込み)`
        : `リセット時 ${projection.pctAtReset}% 見込み`,
    );
  }
  if (projection?.basis === "growth") {
    parts.push(
      projection.exhaustsAt
        ? `1 日あたり ${Math.round(projection.perDay).toLocaleString("en-US")} 増えており、このペースだと上限に届く`
        : "増加ペースからは 1 年以内に上限に届かない見込み",
    );
  }
  return parts.join("・");
}
