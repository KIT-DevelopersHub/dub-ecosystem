// #902: escalation level / projection / Issue + playbook links on the usage screen.
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../lib/api-client.tsx";
import { createUsageApi, USAGE_ALERT_REPO_URL, type UsageApi } from "./usageApi.tsx";
import { buildMockUsageSummary } from "./mockUsageSummary.ts";
import { UsageApiProvider } from "./UsageProvider.tsx";
import { UsageDashboard } from "./UsageDashboard.tsx";
import { ServiceUsageCard } from "./components/ServiceUsageCard.tsx";
import { effectiveLevel, formatProjection, groupServicesByProvider, levelMeta } from "./usageStatus.ts";
import type { UsageIssuesResult } from "./types.ts";

const NOW = new Date("2026-11-27T03:00:00Z");

function wrap(ui: ReactNode, api: UsageApi): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <UsageApiProvider value={api}>{ui}</UsageApiProvider>
    </QueryClientProvider>
  );
}

describe("escalation helpers", () => {
  it("labels the ladder and falls back to the legacy status", () => {
    expect(levelMeta("warn").label).toBe("注意");
    expect(levelMeta("act").label).toBe("対策");
    expect(levelMeta("critical").label).toBe("危険");
    expect(effectiveLevel({ status: "warn" })).toBe("warn");
    expect(effectiveLevel({ status: "warn", level: "act" })).toBe("act");
  });
  it("formats window and growth projections", () => {
    expect(formatProjection({ basis: "window", exhaustsAt: null, pctAtReset: 40, perDay: 1 }, NOW)).toContain("リセットまで持つ");
    expect(formatProjection({ basis: "window", exhaustsAt: "2026-11-27T05:00:00Z", pctAtReset: 130, perDay: 1 }, NOW)).toContain("リセット時 130%");
    expect(formatProjection({ basis: "window", exhaustsAt: "2026-11-27T01:00:00Z", pctAtReset: 130, perDay: 1 }, NOW)).toContain("すでに上限");
    expect(formatProjection({ basis: "growth", exhaustsAt: null, pctAtReset: null, perDay: 0 }, NOW)).toContain("1 年以内に満杯にならない");
    expect(formatProjection(null, NOW)).toBeNull();
  });
  it("sorts act above warn inside a group", () => {
    const s = buildMockUsageSummary(NOW);
    const cf = groupServicesByProvider(s.services).find((g) => g.provider === "cloudflare")!;
    expect(cf.services.map((x) => x.level).slice(0, 3)).toEqual(["critical", "act", "warn"]);
  });
});

describe("open Issues lookup", () => {
  it("never calls GitHub from the browser: the Issues are in a private repo", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const live = createUsageApi({} as ApiClient, {});
    expect(await live.getOpenIssues!()).toEqual({ available: false, byMetric: {} });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it("demo shows a sample Issue in the private alert repo", async () => {
    const demo = createUsageApi({} as ApiClient, { VITE_DEMO: "1" });
    expect((await demo.getOpenIssues!()).byMetric.kv_reads_day?.url).toContain(USAGE_ALERT_REPO_URL);
  });
  it("the search link points at the private alert repo, not dub-ecosystem", () => {
    const kv = buildMockUsageSummary(NOW).services.find((s) => s.metricKey === "kv_reads_day")!;
    expect(kv.issueSearchUrl).toContain("/KIT-DevelopersHub/dub-docs/issues?q=");
  });
});

describe("ServiceUsageCard escalation panel", () => {
  const kv = buildMockUsageSummary(NOW).services.find((s) => s.metricKey === "kv_reads_day")!;
  it("shows the level, projection, action, Issue, playbook and paid plan", () => {
    render(
      <ServiceUsageCard
        service={kv}
        now={NOW}
        issue={{ loading: false, issue: { metricKey: "kv_reads_day", number: 12, url: "https://example.test/12", title: "t" } }}
      />,
    );
    const card = screen.getByTestId("fe2-usage-card-kv_reads_day");
    expect(card).toHaveAttribute("data-level", "critical");
    expect(within(card).getByTestId("fe2-usage-card-kv_reads_day-status")).toHaveTextContent("危険");
    expect(screen.getByTestId("fe2-usage-card-kv_reads_day-escalation-projection")).toHaveTextContent("このペースだと");
    expect(screen.getByTestId("fe2-usage-card-kv_reads_day-escalation-action")).toHaveTextContent("課金を決める");
    expect(screen.getByTestId("fe2-usage-card-kv_reads_day-escalation-issue")).toHaveAttribute("href", "https://example.test/12");
    expect(screen.getByTestId("fe2-usage-card-kv_reads_day-escalation-playbook").getAttribute("href")).toMatch(/11-usage-free-tier\/kv\.md$/);
    expect(screen.getByTestId("fe2-usage-card-kv_reads_day-escalation-paid")).toHaveTextContent("Workers Paid");
  });
  it("shows a skeleton while the Issue lookup loads, and a search link when none is open", () => {
    const { unmount } = render(<ServiceUsageCard service={kv} now={NOW} issue={{ loading: true }} />);
    expect(screen.getByTestId("fe2-usage-card-kv_reads_day-escalation-issue-skeleton")).toBeInTheDocument();
    unmount();
    render(<ServiceUsageCard service={kv} now={NOW} issue={{ loading: false }} />);
    expect(screen.getByTestId("fe2-usage-card-kv_reads_day-escalation-issue-search").getAttribute("href")).toContain("label%3Aarea%3Ausage");
  });
  it("keeps an ok card quiet: no action, no paid line", () => {
    const ok = buildMockUsageSummary(NOW).services.find((s) => s.metricKey === "workers_requests_day")!;
    render(<ServiceUsageCard service={ok} now={NOW} />);
    expect(screen.queryByTestId("fe2-usage-card-workers_requests_day-escalation-action")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-usage-card-workers_requests_day-escalation-paid")).not.toBeInTheDocument();
    expect(screen.getByTestId("fe2-usage-card-workers_requests_day-escalation-playbook")).toBeInTheDocument();
  });
});

describe("UsageDashboard escalation", () => {
  it("renders the ladder guide and links each card to its open Issue", async () => {
    const summary = buildMockUsageSummary(NOW);
    const issues: UsageIssuesResult = {
      available: true,
      byMetric: { d1_rows_read_day: { metricKey: "d1_rows_read_day", number: 950, url: "https://example.test/950", title: "t" } },
    };
    const api: UsageApi = {
      getSummary: vi.fn(async () => ({ summary, source: "live" as const })),
      refresh: vi.fn(async () => ({ summary, source: "live" as const })),
      getOpenIssues: vi.fn(async () => issues),
    };
    render(wrap(<UsageDashboard />, api));
    const guide = await screen.findByTestId("fe2-usage-escalation-guide");
    expect(guide).toHaveTextContent("対策するか、課金するか");
    expect(guide).toHaveTextContent("85%");
    await waitFor(() =>
      expect(screen.getByTestId("fe2-usage-card-d1_rows_read_day-escalation-issue")).toHaveTextContent("Issue #950"),
    );
  });
});
