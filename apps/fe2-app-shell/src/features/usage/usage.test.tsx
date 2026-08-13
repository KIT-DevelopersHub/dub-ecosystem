// Usage feature tests. Pure mapping helpers (pct→status/color/label/icon, halt/bill
// copy, worst-status banner, provider grouping, billing-guard roll-up, byte/amount
// formatting, reset countdown), the atoms (gauge/overflow/banner/group), the card's
// halt/bill + unknown handling, the api adapter's fallback policy, and the dashboard
// integration — all against a faked UsageApi/ApiClient, green without a backend.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient, type RequestInput } from "../../lib/api-client.tsx";
import {
  CRITICAL_PCT,
  WARN_PCT,
  alertingMetrics,
  billingGuardSummary,
  clampPct,
  formatBytes,
  formatPct,
  formatResetsIn,
  formatUsage,
  groupServicesByProvider,
  overflowMeta,
  providerLabel,
  statusFromPct,
  statusMeta,
  statusSortRank,
  worstStatusBanner,
  worstStatusOf,
} from "./usageStatus.ts";
import { createUsageApi, USAGE_SUMMARY_PATH, type UsageApi } from "./usageApi.tsx";
import { buildMockUsageSummary, buildNeutralUsageSummary } from "./mockUsageSummary.ts";
import { UsageApiProvider } from "./UsageProvider.tsx";
import { UsageGauge } from "./components/UsageGauge.tsx";
import { OverflowBadge } from "./components/OverflowBadge.tsx";
import { UsageSummaryBanner } from "./components/UsageSummaryBanner.tsx";
import { ServiceUsageCard } from "./components/ServiceUsageCard.tsx";
import { UsageDashboard } from "./UsageDashboard.tsx";
import type { ServiceUsage, UsageSummary } from "./types.ts";

// ── pure helpers ──────────────────────────────────────────────────────────────
describe("statusFromPct thresholds", () => {
  it("is ok below the warn threshold", () => {
    expect(statusFromPct(0)).toBe("ok");
    expect(statusFromPct(WARN_PCT - 0.1)).toBe("ok");
  });
  it("is warn at ≥70% and below 90%", () => {
    expect(statusFromPct(WARN_PCT)).toBe("warn");
    expect(statusFromPct(CRITICAL_PCT - 0.1)).toBe("warn");
  });
  it("is critical at ≥90%", () => {
    expect(statusFromPct(CRITICAL_PCT)).toBe("critical");
    expect(statusFromPct(140)).toBe("critical");
  });
});

describe("clampPct", () => {
  it("clamps out-of-range and non-finite values into 0–100", () => {
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(150)).toBe(100);
    expect(clampPct(Number.NaN)).toBe(0);
    expect(clampPct(42.5)).toBe(42.5);
  });
});

describe("statusMeta color/label/icon mapping", () => {
  it("maps each status to a distinct tone, label, icon and token color path", () => {
    expect(statusMeta("ok")).toMatchObject({ tone: "success", label: "余裕あり", icon: "check", colorPath: "color.success.500" });
    expect(statusMeta("warn")).toMatchObject({ tone: "warning", label: "警告", icon: "warning", colorPath: "color.warning.500" });
    expect(statusMeta("critical")).toMatchObject({ tone: "danger", label: "危険", icon: "alert", colorPath: "color.danger.500" });
    expect(statusMeta("unknown")).toMatchObject({ tone: "neutral", label: "取得不可", icon: "info", colorPath: "color.gray.400" });
  });
});

describe("overflowMeta halt/bill (the key clarity signal)", () => {
  it("halt = reassuring: stops at the wall, shield icon, no auto-charge", () => {
    expect(overflowMeta("halt")).toMatchObject({
      tone: "info",
      icon: "shield",
      label: "上限で自動停止（課金なし）",
    });
    expect(overflowMeta("halt").detail).toContain("予期せぬ請求");
  });
  it("bill = alarming: danger tone, alert icon, overflow is charged", () => {
    expect(overflowMeta("bill")).toMatchObject({
      tone: "danger",
      icon: "alert-triangle",
      label: "上限超で課金発生",
    });
    expect(overflowMeta("bill").detail).toContain("従量課金");
  });
});

describe("worstStatusBanner", () => {
  it("gives an ok reassurance and a warn/critical warning (plain text + icon)", () => {
    expect(worstStatusBanner("ok")).toMatchObject({ tone: "success", icon: "check", text: "すべて余裕あり" });
    expect(worstStatusBanner("warn")).toMatchObject({ tone: "warning", text: "一部が警告値です" });
    expect(worstStatusBanner("critical")).toMatchObject({ tone: "danger", text: "上限に迫っている項目があります" });
    expect(worstStatusBanner("unknown").tone).toBe("neutral");
  });
});

describe("provider grouping", () => {
  const svc = (provider: string, metricKey: string, status: ServiceUsage["status"], pct: number): ServiceUsage => ({
    provider,
    metricKey,
    label: metricKey,
    used: pct,
    limit: 100,
    pct,
    unit: "x",
    resetsAt: null,
    overflowBehavior: "halt",
    status,
  });

  it("groups by provider, orders sections (cloudflare→resend→gcp→other) and sorts worst-first within a group", () => {
    const groups = groupServicesByProvider([
      svc("resend", "mail", "ok", 40),
      svc("cloudflare", "a-ok", "ok", 10),
      svc("cloudflare", "b-crit", "critical", 95),
      svc("gcp", "logs", "ok", 24),
      svc("cloudflare", "c-warn", "warn", 75),
    ]);
    expect(groups.map((g) => g.provider)).toEqual(["cloudflare", "resend", "gcp"]);
    const cf = groups.find((g) => g.provider === "cloudflare");
    // cloudflare group: critical, then warn, then ok
    expect(cf?.services.map((s) => s.metricKey)).toEqual(["b-crit", "c-warn", "a-ok"]);
    expect(cf?.worstStatus).toBe("critical");
  });

  it("labels known providers and Title-cases unknown ones gracefully", () => {
    expect(providerLabel("cloudflare")).toBe("Cloudflare");
    expect(providerLabel("resend")).toBe("Resend");
    expect(providerLabel("gcp")).toBe("Google Cloud");
    expect(providerLabel("fastly")).toBe("Fastly");
  });

  it("statusSortRank / worstStatusOf order and roll up as designed", () => {
    expect(statusSortRank("critical")).toBeLessThan(statusSortRank("warn"));
    expect(statusSortRank("ok")).toBeLessThan(statusSortRank("unknown"));
    expect(worstStatusOf(["ok", "unknown"])).toBe("ok");
    expect(worstStatusOf(["ok", "warn", "critical"])).toBe("critical");
    expect(worstStatusOf([])).toBe("unknown");
  });
});

describe("billing-guard roll-up", () => {
  const svc = (behavior: ServiceUsage["overflowBehavior"], label: string): ServiceUsage => ({
    provider: "cloudflare",
    metricKey: label,
    label,
    used: 1,
    limit: 100,
    pct: 1,
    unit: "x",
    resetsAt: null,
    overflowBehavior: behavior,
    status: "ok",
  });

  it("flags allHalt when nothing can bill", () => {
    const g = billingGuardSummary([svc("halt", "a"), svc("halt", "b")]);
    expect(g).toMatchObject({ total: 2, haltCount: 2, billCount: 0, allHalt: true, billMetrics: [] });
  });
  it("names the metrics that can bill", () => {
    const g = billingGuardSummary([svc("halt", "a"), svc("bill", "メール"), svc("bill", "GCS")]);
    expect(g).toMatchObject({ billCount: 2, allHalt: false, billMetrics: ["メール", "GCS"] });
  });
  it("alertingMetrics lists warn/critical labels", () => {
    const summary = buildMockUsageSummary(new Date("2026-08-12T00:00:00Z"));
    const { critical, warn } = alertingMetrics(summary.services);
    expect(critical).toContain("KV 読み取り(日)");
    expect(warn).toContain("D1 ストレージ");
  });
});

describe("formatting", () => {
  it("formatPct is one-decimal and clamped", () => {
    expect(formatPct(12.34)).toBe("12.3%");
    expect(formatPct(120)).toBe("100.0%");
    expect(formatPct(Number.NaN)).toBe("—");
  });
  it("formatBytes scales to human GB/MB and guards unknowns", () => {
    expect(formatBytes(1_073_741_824)).toBe("1.0 GB");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("—");
  });
  it("formatUsage renders bytes as GB and keeps the wire unit otherwise", () => {
    expect(formatUsage(5_000_000_000, 5_000_000_000, "bytes")).toBe("4.7 GB / 4.7 GB");
    expect(formatUsage(123, 1000, "req/day")).toBe("123 / 1,000 req/day");
  });
  it("formatResetsIn handles null, past and future windows", () => {
    const now = new Date("2026-08-12T00:00:00Z");
    expect(formatResetsIn(null, now)).toBe("リセットなし");
    expect(formatResetsIn("2026-08-11T00:00:00Z", now)).toBe("まもなくリセット");
    expect(formatResetsIn("2026-08-14T00:00:00Z", now)).toBe("あと約2日");
    expect(formatResetsIn("2026-08-12T05:00:00Z", now)).toBe("あと約5時間");
  });
});

// ── atoms ─────────────────────────────────────────────────────────────────────
describe("UsageGauge", () => {
  it("renders a progressbar carrying the status, rounded value and threshold marks", () => {
    render(<UsageGauge pct={76} status="warn" testId="g" />);
    const bar = screen.getByTestId("g");
    expect(bar).toHaveAttribute("role", "progressbar");
    expect(bar).toHaveAttribute("data-status", "warn");
    expect(bar).toHaveAttribute("aria-valuenow", "76");
    // 70/90 threshold markers are drawn for a known metric.
    expect(screen.getByTestId("g-warn-mark")).toBeInTheDocument();
    expect(screen.getByTestId("g-critical-mark")).toBeInTheDocument();
  });
  it("marks unknown as 取得不可 with no numeric value and no threshold marks", () => {
    render(<UsageGauge pct={0} status="unknown" testId="g" />);
    const bar = screen.getByTestId("g");
    expect(bar).toHaveAttribute("data-status", "unknown");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).toHaveAttribute("aria-valuetext", "取得不可");
    expect(screen.queryByTestId("g-warn-mark")).not.toBeInTheDocument();
  });
});

describe("OverflowBadge", () => {
  it("shows the halt (reassuring) copy", () => {
    render(<OverflowBadge behavior="halt" />);
    expect(screen.getByText("上限で自動停止（課金なし）")).toBeInTheDocument();
  });
  it("shows the bill (alarming) copy", () => {
    render(<OverflowBadge behavior="bill" />);
    expect(screen.getByText("上限超で課金発生")).toBeInTheDocument();
  });
});

describe("UsageSummaryBanner", () => {
  it("renders the worst-status message and names the alerting metrics", () => {
    const summary = buildMockUsageSummary(new Date("2026-08-12T00:00:00Z"));
    render(<UsageSummaryBanner worstStatus="critical" services={summary.services} />);
    const banner = screen.getByTestId("fe2-usage-summary-banner");
    expect(banner).toHaveAttribute("data-status", "critical");
    expect(banner).toHaveTextContent("上限に迫っている");
    expect(screen.getByTestId("fe2-usage-summary-metrics")).toHaveTextContent("KV 読み取り(日)");
  });
  it("reassures when every metric halts (no unexpected bill)", () => {
    const services: ServiceUsage[] = buildMockUsageSummary().services.map((s) => ({ ...s, overflowBehavior: "halt", status: "ok" }));
    render(<UsageSummaryBanner worstStatus="ok" services={services} />);
    expect(screen.getByTestId("fe2-usage-summary-billing")).toHaveTextContent("予期せぬ請求は発生しません");
  });
  it("omits the billing line in the neutral (unknown) state", () => {
    render(<UsageSummaryBanner worstStatus="unknown" services={buildNeutralUsageSummary().services} />);
    expect(screen.queryByTestId("fe2-usage-summary-billing")).not.toBeInTheDocument();
  });
});

// ── card ──────────────────────────────────────────────────────────────────────
const unknownService: ServiceUsage = {
  provider: "cloudflare",
  metricKey: "kv_storage",
  label: "KV ストレージ",
  used: 0,
  limit: 1000,
  pct: 0,
  unit: "bytes",
  resetsAt: null,
  overflowBehavior: "bill",
  status: "unknown",
};

describe("ServiceUsageCard", () => {
  it("renders an unknown metric as 取得不可 instead of a percentage", () => {
    render(<ServiceUsageCard service={unknownService} testId="card" />);
    expect(screen.getByTestId("card")).toHaveAttribute("data-status", "unknown");
    expect(screen.getByTestId("card-pct")).toHaveTextContent("取得不可");
    expect(screen.getByTestId("card-status")).toHaveTextContent("取得不可");
  });
  it("renders a known halt metric with pct, amount and the reassuring halt row", () => {
    const svc: ServiceUsage = { ...unknownService, metricKey: "reqs", pct: 12.3, used: 123, limit: 1000, unit: "req/day", status: "ok", overflowBehavior: "halt" };
    render(<ServiceUsageCard service={svc} testId="card" />);
    expect(screen.getByTestId("card-pct")).toHaveTextContent("12.3%");
    expect(screen.getByTestId("card-amount")).toHaveTextContent("123 / 1,000 req/day");
    const overflow = screen.getByTestId("card-overflow");
    expect(overflow).toHaveAttribute("data-behavior", "halt");
    expect(overflow).toHaveTextContent("上限で自動停止（課金なし）");
  });
  it("renders a bill metric with the alarming bill row and formats byte storage as GB", () => {
    const svc: ServiceUsage = { ...unknownService, metricKey: "d1", label: "D1 ストレージ", pct: 73, used: 3_650_000_000, limit: 5_000_000_000, unit: "bytes", status: "warn", overflowBehavior: "bill" };
    render(<ServiceUsageCard service={svc} testId="card" />);
    expect(screen.getByTestId("card-amount")).toHaveTextContent("GB");
    const overflow = screen.getByTestId("card-overflow");
    expect(overflow).toHaveAttribute("data-behavior", "bill");
    expect(overflow).toHaveTextContent("上限超で課金発生");
  });
});

// ── api adapter fallback policy ────────────────────────────────────────────────
function fakeApi(handler: (input: RequestInput) => unknown): { api: ApiClient; calls: RequestInput[] } {
  const calls: RequestInput[] = [];
  const request = vi.fn(<TRes,>(input: RequestInput): Promise<TRes> => {
    calls.push(input);
    return Promise.resolve(handler(input) as TRes);
  });
  return { api: { request } as unknown as ApiClient, calls };
}

describe("createUsageApi", () => {
  it("GETs /api/v1/usage/summary and returns source:live on success", async () => {
    const wire = buildMockUsageSummary();
    const { api, calls } = fakeApi(() => wire);
    const res = await createUsageApi(api, {}).getSummary();
    expect(calls[0]).toMatchObject({ method: "GET", path: USAGE_SUMMARY_PATH });
    expect(res.source).toBe("live");
    expect(res.summary).toBe(wire);
  });
  it("falls back to a NEUTRAL summary (source:unavailable, reason:error) when the request rejects", async () => {
    const request = vi.fn(() => Promise.reject(new Error("network")));
    const api = { request } as unknown as ApiClient;
    const res = await createUsageApi(api, {}).getSummary();
    expect(res.source).toBe("unavailable");
    expect(res.reason).toBe("error");
    // The neutral fallback must NEVER carry the mock's illustrative warn/critical
    // numbers — every leaf is `unknown` and the roll-up is `unknown`.
    expect(res.summary.worstStatus).toBe("unknown");
    expect(res.summary.services.length).toBeGreaterThan(0);
    expect(res.summary.services.every((s) => s.status === "unknown")).toBe(true);
    expect(res.summary.services.some((s) => s.status === "warn" || s.status === "critical")).toBe(false);
  });
  it("reports reason:forbidden on a 401/403 (session lapsed / not authenticated)", async () => {
    const forbidden = new ApiError(403, { error: { code: "FORBIDDEN", message: "no", retryable: false } });
    const request = vi.fn(() => Promise.reject(forbidden));
    const api = { request } as unknown as ApiClient;
    const res = await createUsageApi(api, {}).getSummary();
    expect(res.source).toBe("unavailable");
    expect(res.reason).toBe("forbidden");
  });
  it("returns the mock (source:demo) without any request in demo builds", async () => {
    const { api, calls } = fakeApi(() => ({}));
    const res = await createUsageApi(api, { VITE_DEMO: "1" }).getSummary();
    expect(calls).toHaveLength(0);
    expect(res.source).toBe("demo");
  });
  it("falls back to unavailable (not mock) when the payload is malformed", async () => {
    const { api } = fakeApi(() => ({ generatedAt: "x", worstStatus: "ok" }));
    const res = await createUsageApi(api, {}).getSummary();
    expect(res.source).toBe("unavailable");
    expect(res.reason).toBe("error");
  });
});

// ── dashboard integration ───────────────────────────────────────────────────
function fakeUsageApi(
  source: "live" | "demo" | "unavailable",
  summary: UsageSummary,
  reason?: "forbidden" | "error",
): { value: UsageApi; refresh: ReturnType<typeof vi.fn> } {
  const result = { summary, source, ...(reason ? { reason } : {}) };
  const getSummary = vi.fn(() => Promise.resolve(result));
  const refresh = vi.fn(() => Promise.resolve(result));
  return { value: { getSummary, refresh }, refresh };
}

function wrap(ui: ReactNode, api: UsageApi): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <UsageApiProvider value={api}>{ui}</UsageApiProvider>
    </QueryClientProvider>
  );
}

describe("UsageDashboard", () => {
  it("renders the banner, reassurance note and provider-grouped cards", async () => {
    const summary = buildMockUsageSummary(new Date("2026-08-12T00:00:00Z"));
    const { value } = fakeUsageApi("live", summary);
    render(wrap(<UsageDashboard />, value));

    await waitFor(() => expect(screen.getByTestId("fe2-usage-summary-banner")).toBeInTheDocument());
    // reassurance copy makes the halt-not-bill point explicit
    expect(screen.getByTestId("fe2-usage-reassurance")).toHaveTextContent("勝手に課金されることはありません");
    // grouped by provider (Cloudflare / Resend / GCP sections)
    expect(screen.getByTestId("fe2-usage-group-cloudflare")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-usage-group-resend")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-usage-group-gcp")).toBeInTheDocument();
    // one card per service, wherever grouped
    expect(screen.getByTestId("fe2-usage-card-workers_requests_day")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-usage-card-emails_month")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-usage-card-d1_storage")).toBeInTheDocument();
    // halt vs bill both visible on cards
    expect(screen.getByTestId("fe2-usage-card-workers_requests_day-overflow")).toHaveAttribute("data-behavior", "halt");
    expect(screen.getByTestId("fe2-usage-card-emails_month-overflow")).toHaveAttribute("data-behavior", "bill");
    // live source → no sample notice
    expect(screen.queryByTestId("fe2-usage-sample-notice")).not.toBeInTheDocument();
  });

  it("floats the worst-status card to the top of its group", async () => {
    const summary = buildMockUsageSummary(new Date("2026-08-12T00:00:00Z"));
    const { value } = fakeUsageApi("live", summary);
    render(wrap(<UsageDashboard />, value));
    await waitFor(() => expect(screen.getByTestId("fe2-usage-group-cloudflare-grid")).toBeInTheDocument());
    const grid = screen.getByTestId("fe2-usage-group-cloudflare-grid");
    const firstCard = grid.querySelector("[data-status]");
    // critical KV reads should surface first in the Cloudflare group
    expect(firstCard).toHaveAttribute("data-status", "critical");
  });

  it("shows a NEUTRAL 'could not read' notice (no fake %/danger) when the read is unavailable", async () => {
    // Simulate the real degraded path: a neutral, all-unknown summary tagged forbidden.
    const summary = buildNeutralUsageSummary(new Date("2026-08-12T00:00:00Z"));
    const { value } = fakeUsageApi("unavailable", summary, "forbidden");
    render(wrap(<UsageDashboard />, value));

    await waitFor(() => expect(screen.getByTestId("fe2-usage-unavailable-notice")).toBeInTheDocument());
    const notice = screen.getByTestId("fe2-usage-unavailable-notice");
    expect(notice).toHaveAttribute("data-reason", "forbidden");
    expect(notice).toHaveTextContent("権限がありません");
    // The old yellow "sample data" notice must NOT appear.
    expect(screen.queryByTestId("fe2-usage-sample-notice")).not.toBeInTheDocument();
    // The page banner must be neutral (unknown) — never the red critical alarm.
    const banner = screen.getByTestId("fe2-usage-summary-banner");
    expect(banner).toHaveAttribute("data-status", "unknown");
    expect(banner).not.toHaveTextContent("上限に迫っている");
    // No billing reassurance line is asserted while data is unavailable.
    expect(screen.queryByTestId("fe2-usage-summary-billing")).not.toBeInTheDocument();
    // Every card renders as 取得不可 with no percentage and no 危険/警告 badge.
    for (const svc of summary.services) {
      const card = screen.getByTestId(`fe2-usage-card-${svc.metricKey}`);
      expect(card).toHaveAttribute("data-status", "unknown");
    }
    expect(screen.queryByText("危険")).not.toBeInTheDocument();
    expect(screen.queryByText("警告")).not.toBeInTheDocument();
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
  });

  it("re-fetches on 今すぐ更新", async () => {
    const summary = buildMockUsageSummary(new Date("2026-08-12T00:00:00Z"));
    const { value } = fakeUsageApi("live", summary);
    render(wrap(<UsageDashboard />, value));
    await waitFor(() => expect(screen.getByTestId("fe2-usage-refresh")).toBeInTheDocument());

    (value.getSummary as ReturnType<typeof vi.fn>).mockClear();
    await userEvent.click(screen.getByTestId("fe2-usage-refresh"));
    await waitFor(() => expect(value.getSummary).toHaveBeenCalled());
  });
});
