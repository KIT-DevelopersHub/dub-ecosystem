// LP管理 → ログ管理(流入ログ) tests.
//
// 目的は「デモで開いたら真っ白/空だった」を二度と起こさないこと。したがって
//   (1) lpRange の純粋関数（期間の閉区間・整形）
//   (2) demo transport が lpApi のワイヤ契約に実データで応答すること
//       (REAL api-client 経由 = 実際のデモ配信と同じ経路)
//   (3) LpVisitLogScreen がそのデータで KPI/内訳/生ログを実描画すること
// の3層を押さえる。(2)(3) が緑なら、デモ URL で空にならないことの裏取りになる。
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { createLpApi, type LpApi } from "./lpApi.tsx";
import { LpApiProvider } from "./LpProvider.tsx";
import { LpVisitLogScreen } from "./LpVisitLogScreen.tsx";
import { barPercent, formatDayLabel, rangeForDays, sharePercent, sourceLabel } from "./lpRange.ts";

// LpTabs は router の useNavigate を使うだけなので、スクリーン単体では spy に差し替える。
const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateSpy, useRouter: () => null }));

function demoLpApi(): LpApi {
  return createLpApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() }));
}

function wrap(api: LpApi): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <LpApiProvider value={api}>
        <LpVisitLogScreen />
      </LpApiProvider>
    </QueryClientProvider>
  );
}

/** 流入URL 側は ログ管理 の表示に関与しないので、スタブは「呼ばれたら落ちる」にしておく
 *  （知らないうちに依存が増えたらテストが気づく）。 */
const linksStubs = {
  listLinks: () => Promise.reject(new Error("not used by LpVisitLogScreen")),
  createLink: () => Promise.reject(new Error("not used by LpVisitLogScreen")),
  setLinkActive: () => Promise.reject(new Error("not used by LpVisitLogScreen")),
};

const UNCONFIGURED_SITE = {
  configured: false,
  range: { from: "2026-09-01", to: "2026-09-28" },
  totals: { pageViews: 0, visits: 0 },
  byDay: [],
  byReferrer: [],
};

function emptyApi(): LpApi {
  return {
    ...linksStubs,
    getSiteTraffic: () => Promise.resolve(UNCONFIGURED_SITE),
    getStats: () =>
      Promise.resolve({
        range: { from: "2026-09-01", to: "2026-09-28" },
        totals: { visits: 0, uniques: 0, botExcluded: 0 },
        bySource: [],
        byDay: [],
        byDevice: [],
      }),
    listVisits: () => Promise.resolve({ items: [], nextCursor: null }),
  };
}

describe("lpRange (pure)", () => {
  it("builds an inclusive day range ending today", () => {
    const now = new Date(2026, 8, 28); // 2026-09-28 local
    expect(rangeForDays(7, now)).toEqual({ from: "2026-09-22", to: "2026-09-28" });
    expect(rangeForDays(30, now).from).toBe("2026-08-30");
  });

  it("keeps a 1-visit bar visible and computes shares", () => {
    expect(barPercent(1, 500)).toBe(2); // 0% に潰れない
    expect(barPercent(5, 0)).toBe(0);
    expect(sharePercent(1, 3)).toBe(33.3);
    expect(sharePercent(1, 0)).toBe(0);
  });

  it("never swallows unknown keys or malformed days", () => {
    expect(sourceLabel("instagram")).toBe("Instagram");
    expect(sourceLabel("tiktok")).toBe("tiktok");
    expect(formatDayLabel("2026-09-28")).toBe("9/28");
    expect(formatDayLabel("garbage")).toBe("garbage");
  });
});

describe("demo transport serves the LP visit wire contract", () => {
  it("returns non-empty stats for the default 30-day range", async () => {
    const api = demoLpApi();
    const range = rangeForDays(30);
    const stats = await api.getStats({ ...range, includeBots: false });

    expect(stats.totals.visits).toBeGreaterThan(0);
    expect(stats.totals.uniques).toBeGreaterThan(0);
    // 再訪を含むので のべ >= 一意。逆なら集計が壊れている。
    expect(stats.totals.visits).toBeGreaterThanOrEqual(stats.totals.uniques);
    expect(stats.bySource.length).toBeGreaterThan(1);
    expect(stats.byDevice.length).toBeGreaterThan(0);
    // 0 件の日も行として残す（30日 = 30行）。
    expect(stats.byDay).toHaveLength(30);
    // bot は除外され、除外件数が報告される。
    expect(stats.totals.botExcluded).toBeGreaterThan(0);
  });

  it("pages raw visits with a working cursor and hides bots", async () => {
    const api = demoLpApi();
    const range = rangeForDays(30);
    const first = await api.listVisits({ ...range, limit: 25 });
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).toBeTruthy();
    expect(first.items.every((v) => v.device !== "bot")).toBe(true);
    // 新しい順。
    expect(first.items[0]!.occurredAt >= first.items[1]!.occurredAt).toBe(true);

    const second = await api.listVisits({ ...range, limit: 25, cursor: first.nextCursor! });
    expect(second.items.length).toBeGreaterThan(0);
    // ページが重複しない（カーソルが効いている）。
    const ids = new Set(first.items.map((v) => v.id));
    expect(second.items.some((v) => ids.has(v.id))).toBe(false);
  });

  it("is deterministic: two independent loads show the same totals", async () => {
    const range = rangeForDays(7);
    const a = await demoLpApi().getStats({ ...range, includeBots: false });
    const b = await demoLpApi().getStats({ ...range, includeBots: false });
    expect(a.totals).toEqual(b.totals);
  });
});

describe("LpVisitLogScreen", () => {
  it("renders KPIs, source breakdown and raw log from the demo transport", async () => {
    render(wrap(demoLpApi()));

    // 読み込み中はスケルトン（空状態と混同させない）。
    expect(screen.getByTestId("fe2-lp-visits-loading")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId("fe2-lp-visits-body")).toBeInTheDocument());

    // KPI は「0」や空欄でなく実数値が出る。
    const visitsKpi = screen.getByTestId("fe2-lp-kpi-visits");
    expect(within(visitsKpi).getByText("総訪問(のべ)")).toBeInTheDocument();
    expect(within(visitsKpi).getByText(/^[1-9][\d,]*$/)).toBeInTheDocument();
    expect(screen.getByTestId("fe2-lp-kpi-uniques")).toBeInTheDocument();

    // 流入元別の棒が実際に描画され、代表的な流入元が並ぶ。
    const bars = screen.getAllByTestId("fe2-lp-source-bars")[0]!;
    expect(within(bars).getByText("Instagram")).toBeInTheDocument();

    // 生ログの表に行がある。
    expect(screen.getByTestId("fe2-lp-visits-table")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-lp-visits-more")).toBeInTheDocument();

    // タブ帯（バージョン ⇄ ログ管理）が出ている。
    expect(screen.getByTestId("fe2-lp-tabs")).toBeInTheDocument();
  });

  it("shows the empty state (not a blank screen) when there is no data", async () => {
    render(wrap(emptyApi()));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-visits-empty")).toBeInTheDocument());
    expect(screen.getByText("まだログがありません")).toBeInTheDocument();
  });

  it("shows a retryable error state when the api fails", async () => {
    const failing: LpApi = {
      ...linksStubs,
      getSiteTraffic: () => Promise.reject(new Error("boom")),
      getStats: () => Promise.reject(new Error("boom")),
      listVisits: () => Promise.reject(new Error("boom")),
    };
    render(wrap(failing));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-visits-error")).toBeInTheDocument());
    expect(screen.getByTestId("fe2-lp-site-error")).toBeInTheDocument();
  });
});

describe("サイト全体のアクセス (Cloudflare)", () => {
  it("demo transport answers the real measured numbers", async () => {
    const site = await demoLpApi().getSiteTraffic({ from: "2026-09-28", to: "2026-10-10" });
    expect(site.configured).toBe(true);
    expect(site.byDay).toHaveLength(13);
    expect(site.byDay.find((d) => d.date === "2026-10-01")).toEqual({ date: "2026-10-01", pageViews: 82, visits: 45 });
    expect(site.byReferrer.map((r) => r.label)).toContain("X (Twitter)");
  });

  it("renders PV / 訪問 / referrers / per-day even when the 流入URL log is empty", async () => {
    const api: LpApi = {
      ...emptyApi(),
      getSiteTraffic: () =>
        Promise.resolve({
          configured: true,
          range: { from: "2026-10-01", to: "2026-10-02" },
          totals: { pageViews: 111, visits: 63 },
          byDay: [
            { date: "2026-10-01", pageViews: 82, visits: 45 },
            { date: "2026-10-02", pageViews: 29, visits: 18 },
          ],
          byReferrer: [{ key: "t.co", label: "X (Twitter)", pageViews: 24, visits: 24 }],
        }),
    };
    render(wrap(api));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-site-body")).toBeInTheDocument());
    expect(within(screen.getByTestId("fe2-lp-site-kpi-pv")).getByText("111")).toBeInTheDocument();
    expect(within(screen.getByTestId("fe2-lp-site-referrers")).getByText("X (Twitter)")).toBeInTheDocument();
    expect(within(screen.getByTestId("fe2-lp-site-byday")).getByText("10/1")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-lp-visits-empty")).toBeInTheDocument();
  });

  it("says 未設定 instead of showing zeros when Cloudflare is not configured", async () => {
    render(wrap(emptyApi()));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-site-unconfigured")).toBeInTheDocument());
  });
});
