// Dashboard model + demo data (design 2-1 "ダッシュボード" revamp). Pure, React-free.
//
// The Home screen shows two kinds of number:
//   • LIVE — derived from /bff/home (upcoming-event count, unread count) and from
//     the wall clock (countdown to the conference). These are real.
//   • DEMO — free-tier usage %, task-completion breakdown, member/team counts.
//     /bff/home does not aggregate these yet, so the dashboard renders illustrative
//     values flagged with a "デモ" tag. They are never presented as live figures.
//
// Keeping the demo values + the status/threshold mapping here (not inline in the
// screen) means the component tree stays presentational and every threshold is
// unit-tested. Colors are dotted @dub/tokens paths the chart components resolve via
// toCssVarName — no ad-hoc hex, so light/dark both track the theme.
import type { BadgeTone } from "@dub/ui";

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

// ── DEMO: free-tier usage (Cloudflare / Resend) ────────────────────────────────
// Illustrative snapshot — same shape/values family as the 無料枠 dashboard's mock.
export interface FreeTierMetric {
  key: string;
  label: string;
  pct: number;
}
export const FREE_TIER: FreeTierMetric[] = [
  { key: "kv_reads", label: "KV 読み取り(日)", pct: 96.5 },
  { key: "d1_rows", label: "D1 行読み取り(日)", pct: 76.0 },
  { key: "workers", label: "Workers リクエスト(日)", pct: 12.3 },
  { key: "emails", label: "メール送信(月)", pct: 40.0 },
];

/** The most-stressed free-tier metric (drives the headline 無料枠 KPI). */
export function worstFreeTier(metrics: FreeTierMetric[] = FREE_TIER): FreeTierMetric {
  return metrics.reduce((worst, m) => (m.pct > worst.pct ? m : worst), metrics[0]!);
}

// ── DEMO: task completion breakdown ─────────────────────────────────────────────
export interface TaskSegment {
  key: string;
  label: string;
  count: number;
  status: MetricStatus;
}
export const TASK_SEGMENTS: TaskSegment[] = [
  { key: "done", label: "完了", count: 30, status: "good" },
  { key: "in_progress", label: "進行中", count: 10, status: "info" },
  { key: "todo", label: "未着手", count: 6, status: "warn" },
  { key: "blocked", label: "ブロック", count: 2, status: "critical" },
];

export function taskTotal(segments: TaskSegment[] = TASK_SEGMENTS): number {
  return segments.reduce((sum, s) => sum + s.count, 0);
}

/** Completion % = done / total (0 when there are no tasks). */
export function taskCompletionPct(segments: TaskSegment[] = TASK_SEGMENTS): number {
  const total = taskTotal(segments);
  if (total === 0) return 0;
  const done = segments.find((s) => s.key === "done")?.count ?? 0;
  return (done / total) * 100;
}

// ── DEMO: 運営メンバー / チーム ───────────────────────────────────────────────
export const TEAM_STATS = { members: 18, teams: 5 } as const;
