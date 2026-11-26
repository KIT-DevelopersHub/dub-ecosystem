// LP管理 > ログ管理「詳しい分析」(#904)。デモ transport（本番と同じ buildInsights）で描画まで確かめる。
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { lpInsights } from "@dub/types";
import { createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { createLpApi, type LpApi } from "./lpApi.tsx";
import { LpApiProvider } from "./LpProvider.tsx";
import { LpInsightsCard, formatDuration, sectionLabel } from "./LpInsightsCard.tsx";
import { rangeForDays } from "./lpRange.ts";

function wrap(api: LpApi, range = rangeForDays(30)): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <LpApiProvider value={api}>
        <LpInsightsCard range={range} />
      </LpApiProvider>
    </QueryClientProvider>
  );
}

const demoApi = (): LpApi => createLpApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() }));

describe("LpInsightsCard", () => {
  it("shows a skeleton first, then KPI / trend / funnel / sources / sections / CTAs / devices / vitals", async () => {
    render(wrap(demoApi()));
    expect(screen.getByTestId("fe2-lp-ins-loading")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("fe2-lp-ins-body")).toBeInTheDocument());
    for (const id of [
      "fe2-lp-ins-kpi-sessions",
      "fe2-lp-ins-chart",
      "fe2-lp-ins-funnel-bars",
      "fe2-lp-ins-sources-table",
      "fe2-lp-ins-pages-table",
      "fe2-lp-ins-section-bars",
      "fe2-lp-ins-scroll-bars",
      "fe2-lp-ins-ctas-table",
      "fe2-lp-ins-device-bars",
      "fe2-lp-ins-region-bars",
      "fe2-lp-ins-vitals-table",
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    const funnel = screen.getByTestId("fe2-lp-ins-funnel-bars");
    expect(within(funnel).getByText("LP を訪問")).toBeInTheDocument();
    expect(within(funnel).getByText("申し込み完了")).toBeInTheDocument();
    expect(within(screen.getByTestId("fe2-lp-ins-region-bars")).getByText("石川県")).toBeInTheDocument();
    expect(within(screen.getByTestId("fe2-lp-ins-section-bars")).getByText("参加・登壇 (Join)")).toBeInTheDocument();
  });

  it("empty range → empty state (not zeros)", async () => {
    const api = { ...demoApi(), getInsights: (q: { from: string; to: string }) => Promise.resolve(lpInsights.buildInsights([], q, [])) };
    render(wrap(api));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-ins-empty")).toBeInTheDocument());
  });

  it("failure → retryable error", async () => {
    const api = { ...demoApi(), getInsights: () => Promise.reject(new Error("boom")) };
    render(wrap(api));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-ins-error")).toBeInTheDocument());
  });

  it("formats durations and section names", () => {
    expect(formatDuration(12_345)).toBe("12秒");
    expect(formatDuration(83_000)).toBe("1分23秒");
    expect(sectionLabel("apply")).toBe("参加・登壇 (Join)");
    expect(sectionLabel("program")).toBe("プログラム");
    expect(sectionLabel("float")).toBe("右下の購入ボタン");
  });
});
