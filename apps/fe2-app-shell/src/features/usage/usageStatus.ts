// Pure presentation helpers for the usage dashboard (no React, no tokens import —
// returns dotted token PATHS the components resolve via @dub/tokens' toCssVarName).
// Every mapping here is unit-tested: status→color/label, pct thresholds, halt/bill
// copy, worst-status banner, and reset-countdown formatting.
import type { BadgeTone } from "@dub/ui";
import type { OverflowBehavior, UsageStatus } from "./types.ts";

/** Warn/critical percentage thresholds (design: warn ≥70%, critical ≥90%). */
export const WARN_PCT = 70;
export const CRITICAL_PCT = 90;

/** Clamp an arbitrary wire pct into a safe 0–100 bar width (NaN/neg → 0). */
export function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

/** Derive a status purely from a percentage. The backend already sends `status`;
 *  this is the fallback/threshold definition and the unit-tested source of truth
 *  for the ≥70 / ≥90 cutoffs. `unknown` is never derived — it is a wire signal. */
export function statusFromPct(pct: number): Exclude<UsageStatus, "unknown"> {
  if (!Number.isFinite(pct)) return "ok";
  if (pct >= CRITICAL_PCT) return "critical";
  if (pct >= WARN_PCT) return "warn";
  return "ok";
}

export interface StatusMeta {
  /** @dub/ui Badge tone for this status. */
  tone: BadgeTone;
  /** Short ja label shown on the status badge. */
  label: string;
  /** Dotted @dub/tokens color path for the gauge fill / accent. */
  colorPath: string;
  /** Dotted @dub/tokens color path for a soft tinted surface. */
  softColorPath: string;
}

/** status → { tone, label, token color paths }. The single mapping the gauge,
 *  badge and card all read so color and wording never drift apart. */
export function statusMeta(status: UsageStatus): StatusMeta {
  switch (status) {
    case "ok":
      return { tone: "success", label: "余裕あり", colorPath: "color.success.500", softColorPath: "color.success.100" };
    case "warn":
      return { tone: "warning", label: "警告", colorPath: "color.warning.500", softColorPath: "color.warning.100" };
    case "critical":
      return { tone: "danger", label: "危険", colorPath: "color.danger.500", softColorPath: "color.danger.100" };
    case "unknown":
    default:
      return { tone: "neutral", label: "取得不可", colorPath: "color.gray.400", softColorPath: "color.gray.100" };
  }
}

export interface OverflowMeta {
  tone: BadgeTone;
  label: string;
}

/** overflowBehavior → badge copy. halt is the *safe* free-tier behavior (stops at
 *  the wall, no charge); bill means overflow costs money, so it is flagged. */
export function overflowMeta(behavior: OverflowBehavior): OverflowMeta {
  return behavior === "halt"
    ? { tone: "info", label: "超過すると停止(429)・自動課金なし" }
    : { tone: "warning", label: "超過すると課金" };
}

export interface BannerMeta {
  tone: BadgeTone;
  text: string;
}

/** worstStatus → the page-top summary banner. */
export function worstStatusBanner(status: UsageStatus): BannerMeta {
  switch (status) {
    case "ok":
      return { tone: "success", text: "✓ すべて余裕あり" };
    case "warn":
      return { tone: "warning", text: "⚠ 一部が警告値です" };
    case "critical":
      return { tone: "danger", text: "⚠ 上限に迫っている項目があります" };
    case "unknown":
    default:
      return { tone: "neutral", text: "一部の使用状況を取得できませんでした" };
  }
}

/** Format used/limit with a thin thousands separator, tolerating unknown (-1)
 *  sentinels the backend may send for unreadable metrics. */
export function formatAmount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  return n.toLocaleString("ja-JP");
}

/** "12.3%" — one decimal, clamped, "—" when not a number. */
export function formatPct(pct: number): string {
  if (!Number.isFinite(pct)) return "—";
  return `${clampPct(pct).toFixed(1)}%`;
}

/** Human "resets in" label. null → no rollover; past → "まもなくリセット". */
export function formatResetsIn(resetsAt: string | null, now: Date = new Date()): string {
  if (resetsAt === null) return "リセットなし";
  const target = new Date(resetsAt);
  if (Number.isNaN(target.getTime())) return "—";
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return "まもなくリセット";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / (60 * 24));
  if (days >= 1) return `あと約${days}日`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 1) return `あと約${hours}時間`;
  return `あと約${Math.max(1, minutes)}分`;
}
