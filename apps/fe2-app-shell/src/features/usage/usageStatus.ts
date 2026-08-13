// Pure presentation helpers for the usage dashboard (no React, no tokens import —
// returns dotted token PATHS the components resolve via @dub/tokens' toCssVarName).
// Every mapping here is unit-tested: status→color/label/icon, pct thresholds,
// halt/bill copy, worst-status banner, provider grouping, billing-guard roll-up,
// byte/amount formatting and reset-countdown formatting.
import type { BadgeTone, IconName } from "@dub/ui";
import type { OverflowBehavior, ServiceProvider, ServiceUsage, UsageStatus } from "./types.ts";

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
  /** @dub/ui Icon paired with the label (never color-alone — a11y). */
  icon: IconName;
  /** Dotted @dub/tokens color path for the gauge fill / accent. */
  colorPath: string;
  /** Dotted @dub/tokens color path for a soft tinted surface. */
  softColorPath: string;
}

/** status → { tone, label, icon, token color paths }. The single mapping the gauge,
 *  badge and card all read so color and wording never drift apart. Color is ALWAYS
 *  paired with a label + icon so the state is legible without relying on hue. */
export function statusMeta(status: UsageStatus): StatusMeta {
  switch (status) {
    case "ok":
      return { tone: "success", label: "余裕あり", icon: "check", colorPath: "color.success.500", softColorPath: "color.success.100" };
    case "warn":
      return { tone: "warning", label: "警告", icon: "warning", colorPath: "color.warning.500", softColorPath: "color.warning.100" };
    case "critical":
      return { tone: "danger", label: "危険", icon: "alert", colorPath: "color.danger.500", softColorPath: "color.danger.100" };
    case "unknown":
    default:
      return { tone: "neutral", label: "取得不可", icon: "info", colorPath: "color.gray.400", softColorPath: "color.gray.100" };
  }
}

/** Sort rank so worst statuses surface first within a group (critical→warn→ok→unknown). */
export function statusSortRank(status: UsageStatus): number {
  switch (status) {
    case "critical": return 0;
    case "warn": return 1;
    case "ok": return 2;
    case "unknown":
    default: return 3;
  }
}

/** Severity used to roll a set of statuses up to their worst (unknown is lowest so a
 *  group of [ok, unknown] reads as ok, never as an alarm). */
const SEVERITY: Record<UsageStatus, number> = { critical: 3, warn: 2, ok: 1, unknown: 0 };

/** Worst status across a list (empty → unknown). */
export function worstStatusOf(list: UsageStatus[]): UsageStatus {
  if (list.length === 0) return "unknown";
  return list.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a));
}

export interface OverflowMeta {
  tone: BadgeTone;
  /** @dub/ui Icon: halt = shield (safe), bill = alert (costs money). */
  icon: IconName;
  /** Short chip label. */
  label: string;
  /** One-line plain explanation shown under the chip. */
  detail: string;
}

/** overflowBehavior → the halt/bill distinction — the single most important clarity
 *  ask. halt is the *safe* free-tier behavior (stops at the wall, no charge) so it is
 *  reassuring (shield / info tone); bill means overflow costs money, so it is alarming
 *  (alert / danger tone). Icon + label + detail carry the meaning without color alone. */
export function overflowMeta(behavior: OverflowBehavior): OverflowMeta {
  return behavior === "halt"
    ? {
        tone: "info",
        icon: "shield",
        label: "上限で自動停止（課金なし）",
        detail: "上限に達すると停止（429）。予期せぬ請求は発生しません。",
      }
    : {
        tone: "danger",
        icon: "alert-triangle",
        label: "上限超で課金発生",
        detail: "無料枠を超えた分は従量課金されます。",
      };
}

export interface BannerMeta {
  tone: BadgeTone;
  icon: IconName;
  text: string;
}

/** worstStatus → the page-top summary banner (icon + tone + plain text; no glyphs). */
export function worstStatusBanner(status: UsageStatus): BannerMeta {
  switch (status) {
    case "ok":
      return { tone: "success", icon: "check", text: "すべて余裕あり" };
    case "warn":
      return { tone: "warning", icon: "warning", text: "一部が警告値です" };
    case "critical":
      return { tone: "danger", icon: "alert", text: "上限に迫っている項目があります" };
    case "unknown":
    default:
      return { tone: "neutral", icon: "info", text: "一部の使用状況を取得できませんでした" };
  }
}

// ── provider grouping ───────────────────────────────────────────────────────────
const PROVIDER_LABEL: Record<string, string> = {
  cloudflare: "Cloudflare",
  resend: "Resend",
  gcp: "Google Cloud",
};
/** Preferred section order; unknown providers fall after these, alphabetically. */
const PROVIDER_ORDER = ["cloudflare", "resend", "gcp"];

/** Human provider name. Unknown providers (backend may add more, e.g. "gcp") are
 *  rendered gracefully by Title-casing the raw key rather than crashing/blanking. */
export function providerLabel(provider: ServiceProvider): string {
  return PROVIDER_LABEL[provider] ?? (provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "その他");
}

function providerRank(provider: ServiceProvider): number {
  const i = PROVIDER_ORDER.indexOf(provider);
  return i === -1 ? PROVIDER_ORDER.length : i;
}

export interface ServiceGroupData {
  provider: ServiceProvider;
  label: string;
  /** Sorted worst-status-first so problems surface at the top of each section. */
  services: ServiceUsage[];
  worstStatus: UsageStatus;
}

/** Group metrics by provider (Cloudflare / Resend / [future GCP] / …). Sections are
 *  ordered by a known preference then alphabetically; within a section the worst
 *  status floats to the top (pct desc as a tiebreak). */
export function groupServicesByProvider(services: ServiceUsage[]): ServiceGroupData[] {
  const map = new Map<string, ServiceUsage[]>();
  for (const s of services) {
    const arr = map.get(s.provider) ?? [];
    arr.push(s);
    map.set(s.provider, arr);
  }
  const groups: ServiceGroupData[] = [...map.entries()].map(([provider, list]) => ({
    provider,
    label: providerLabel(provider),
    services: [...list].sort(
      (a, b) => statusSortRank(a.status) - statusSortRank(b.status) || clampPct(b.pct) - clampPct(a.pct),
    ),
    worstStatus: worstStatusOf(list.map((s) => s.status)),
  }));
  groups.sort((a, b) => providerRank(a.provider) - providerRank(b.provider) || a.label.localeCompare(b.label));
  return groups;
}

// ── billing-guard roll-up ────────────────────────────────────────────────────────
export interface BillingGuardSummary {
  total: number;
  haltCount: number;
  billCount: number;
  /** True when EVERY metric halts at the wall — i.e. no path to an unexpected bill. */
  allHalt: boolean;
  /** Labels of the metrics that CAN bill on overflow (the ones to watch). */
  billMetrics: string[];
}

/** Roll the halt/bill split up for the page-top reassurance line: "全項目 自動停止＝
 *  予期せぬ請求なし" when nothing can bill, otherwise which metrics can. */
export function billingGuardSummary(services: ServiceUsage[]): BillingGuardSummary {
  const bill = services.filter((s) => s.overflowBehavior === "bill");
  return {
    total: services.length,
    haltCount: services.length - bill.length,
    billCount: bill.length,
    allHalt: services.length > 0 && bill.length === 0,
    billMetrics: bill.map((s) => s.label),
  };
}

/** Labels of metrics currently at warn / critical, for the banner detail line. */
export function alertingMetrics(services: ServiceUsage[]): { critical: string[]; warn: string[] } {
  return {
    critical: services.filter((s) => s.status === "critical").map((s) => s.label),
    warn: services.filter((s) => s.status === "warn").map((s) => s.label),
  };
}

// ── formatting ─────────────────────────────────────────────────────────────────
/** Format used/limit with a thin thousands separator, tolerating unknown (-1)
 *  sentinels the backend may send for unreadable metrics. */
export function formatAmount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  return n.toLocaleString("ja-JP");
}

/** Binary-scaled byte size, e.g. 1_073_741_824 → "1.0 GB". "—" for unknown/negatives. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return i === 0 ? `${v} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
}

/** "used / limit unit" for a metric — byte units render as human GB/MB (no unit
 *  suffix, since formatBytes already carries it); everything else keeps its wire unit. */
export function formatUsage(used: number, limit: number, unit: string): string {
  if (unit === "bytes" || unit === "byte") {
    return `${formatBytes(used)} / ${formatBytes(limit)}`;
  }
  return `${formatAmount(used)} / ${formatAmount(limit)} ${unit}`;
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
