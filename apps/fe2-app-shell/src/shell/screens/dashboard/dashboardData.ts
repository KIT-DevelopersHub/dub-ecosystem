// Dashboard model + pure derivations (design 2-1 "ダッシュボード" revamp). React-free.
//
// Every headline number on the Home screen is now LIVE: the free-tier usage %,
// task-completion breakdown and member/team counts come from /bff/home (aggregated
// from usage-meter / task-service / member-service), and the conference countdown
// comes from the wall clock. This module holds only the pure status/threshold
// mapping and the small builders that reshape the BFF projection into the chart
// props — so the component tree stays presentational and every threshold is
// unit-tested. Colors are dotted @dub/tokens paths the chart components resolve via
// toCssVarName — no ad-hoc hex, so light/dark both track the theme.
import type { BadgeTone } from "@dub/ui";
import type { task } from "@dub/types";

/** A metric health level. Drives both color and the ja status label so wording and
 *  hue never drift apart (mirrors the usage dashboard's ok/warn/critical language). */
export type MetricStatus = "good" | "warn" | "critical" | "info";

/** Warn/critical percentage cutoffs (shared with the 無料枠 dashboard: warn ≥70%,
 *  critical ≥90%). Exposed for the unit tests that pin the boundaries. */
export const WARN_PCT = 70;
export const CRITICAL_PCT = 90;

/** Clamp an arbitrary percentage into a safe 0–100 bar width (NaN/neg → 0). */
export function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

/** A "capacity used" percentage → health: the fuller, the worse (usage semantics). */
export function usageStatusFromPct(pct: number): MetricStatus {
  if (!Number.isFinite(pct)) return "info";
  if (pct >= CRITICAL_PCT) return "critical";
  if (pct >= WARN_PCT) return "warn";
  return "good";
}

export interface StatusMeta {
  tone: BadgeTone;
  label: string;
  /** dotted @dub/tokens path for the strong fill / accent. */
  colorPath: string;
  /** dotted @dub/tokens path for a soft tinted surface. */
  softColorPath: string;
}

/** status → { tone, label, token color paths }. Single source read by every chart,
 *  badge and tile so color + copy stay in lockstep. */
export function statusMeta(status: MetricStatus): StatusMeta {
  switch (status) {
    case "good":
      return { tone: "success", label: "良好", colorPath: "color.success.500", softColorPath: "color.success.100" };
    case "warn":
      return { tone: "warning", label: "注意", colorPath: "color.warning.500", softColorPath: "color.warning.100" };
    case "critical":
      return { tone: "danger", label: "逼迫", colorPath: "color.danger.500", softColorPath: "color.danger.100" };
    case "info":
    default:
      return { tone: "info", label: "情報", colorPath: "color.brand.500", softColorPath: "color.brand.100" };
  }
}

/** Whole days from `now` until `targetISO` (rounded up; never negative). Used for
 *  the conference countdown — a genuinely live figure. Returns null on a bad date. */
export function daysUntil(targetISO: string, now: Date = new Date()): number | null {
  const target = new Date(targetISO);
  if (Number.isNaN(target.getTime())) return null;
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / 86_400_000);
}

// ── the headline event the countdown tracks (本戦) ──────────────────────────────
export const CONFERENCE = {
  name: "北陸ITカンファレンス",
  /** 本戦 開催日 (JST). Live countdown target. */
  dateISO: "2026-08-22T01:00:00+09:00",
  dateLabel: "2026/08/22",
} as const;

// ── free-tier usage (Cloudflare / Resend), live from usage-meter via /bff/home ──
export interface FreeTierMetric {
  key: string;
  label: string;
  pct: number;
}

/** Reshape the BFF usage projection (pct may be null when unmeasured → 0) into the
 *  meter/KPI props, sorted most-stressed first so the card reads top-down. */
export function freeTierFromMetrics(
  metrics: ReadonlyArray<{ key: string; label: string; pct: number | null }>,
): FreeTierMetric[] {
  return metrics
    .map((m) => ({ key: m.key, label: m.label, pct: m.pct ?? 0 }))
    .sort((a, b) => b.pct - a.pct);
}

/** The most-stressed free-tier metric (drives the headline 無料枠 KPI); null when
 *  there are no metrics. */
export function worstFreeTier(metrics: FreeTierMetric[]): FreeTierMetric | null {
  if (metrics.length === 0) return null;
  return metrics.reduce((worst, m) => (m.pct > worst.pct ? m : worst), metrics[0]!);
}

// ── task completion breakdown, live from task-service via /bff/home ─────────────
export interface TaskSegment {
  key: string;
  label: string;
  count: number;
  status: MetricStatus;
}

/** The active statuses shown in the タスクの内訳 bar / 完了率 gauge, in display order.
 *  `cancelled` is intentionally excluded — it is neither active work nor progress,
 *  so it never dilutes the completion percentage. */
const VISIBLE_TASK_STATUSES: ReadonlyArray<{ key: task.TaskStatus; label: string; status: MetricStatus }> = [
  { key: "done", label: "完了", status: "good" },
  { key: "in_progress", label: "進行中", status: "info" },
  { key: "todo", label: "未着手", status: "warn" },
  { key: "blocked", label: "ブロック", status: "critical" },
];

/** Build the ordered segments from the BFF's per-status counts. */
export function taskSegmentsFromCounts(byStatus: Partial<Record<task.TaskStatus, number>>): TaskSegment[] {
  return VISIBLE_TASK_STATUSES.map(({ key, label, status }) => ({
    key,
    label,
    status,
    count: byStatus[key] ?? 0,
  }));
}

export function taskTotal(segments: TaskSegment[]): number {
  return segments.reduce((sum, s) => sum + s.count, 0);
}

/** Completion % = done / total (0 when there are no tasks). */
export function taskCompletionPct(segments: TaskSegment[]): number {
  const total = taskTotal(segments);
  if (total === 0) return 0;
  const done = segments.find((s) => s.key === "done")?.count ?? 0;
  return (done / total) * 100;
}
