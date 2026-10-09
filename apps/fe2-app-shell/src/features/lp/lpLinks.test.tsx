// LP管理 → 流入URL のテスト。ログ管理と同じ 3 層で押さえる:
//   (1) lpLinks の純粋関数（URL 組み立て・パラメータ値の正規化・検証）
//   (2) demo transport が links のワイヤ契約に応答すること（REAL api-client 経由 = 配信と同経路）
//   (3) LpLinksScreen が実データで発行フォーム + 一覧を描画し、発行が一覧に反映されること
// (2)(3) が緑なら「デモURLを開いたら空/真っ白」が起きないことの裏取りになる。
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { createLpApi, type LpApi } from "./lpApi.tsx";
import { LpApiProvider } from "./LpProvider.tsx";
import { LpLinksScreen } from "./LpLinksScreen.tsx";
import { rangeForDays } from "./lpRange.ts";
import {
  LP_BASE_URL,
  LP_TRACKING_PARAM,
  buildTrackingUrl,
  formatLastVisit,
  normalizeSlug,
  slugifySource,
  validateLinkDraft,
} from "./lpLinks.ts";

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateSpy, useRouter: () => null }));

function demoLpApi(): LpApi {
  return createLpApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() }));
}

function wrap(api: LpApi): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <LpApiProvider value={api}>
          <LpLinksScreen />
        </LpApiProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

describe("lpLinks (pure)", () => {
  it("builds the LP url with the tracking param", () => {
    expect(buildTrackingUrl("instagram")).toBe(`${LP_BASE_URL}/?${LP_TRACKING_PARAM}=instagram`);
    // 既にクエリがある土台でも壊さず上書きする。
    expect(buildTrackingUrl("x", "https://example.com/?a=1")).toBe("https://example.com/?a=1&utm_source=x");
  });

  it("normalizes the param value so one source never splits into two", () => {
    // ユーザーが「X」と大文字で入れても x に揃う（X と x が別集計に割れない）。
    expect(normalizeSlug(" X ")).toBe("x");
    expect(slugifySource("Instagram 告知投稿")).toBe("instagram");
    // 日本語だけの名前は自動生成できない → 空を返して手入力に委ねる（勝手に変換しない）。
    expect(slugifySource("チラシ")).toBe("");
  });

  it("rejects an empty name, a non-ascii param value and a duplicate", () => {
    expect(validateLinkDraft({ name: "", slug: "instagram" }, []).name).toMatch(/名前/);
    expect(validateLinkDraft({ name: "チラシ", slug: "" }, []).slug).toMatch(/半角英数字/);
    expect(validateLinkDraft({ name: "インスタ", slug: "instagram" }, ["instagram"]).slug).toMatch(/既に発行済み/);
    expect(validateLinkDraft({ name: "インスタ", slug: "insta-2" }, ["instagram"])).toEqual({
      name: null,
      slug: null,
    });
  });

  it("says まだなし instead of leaving the last-visit cell blank", () => {
    expect(formatLastVisit(null)).toBe("まだなし");
  });
});

describe("demo transport serves the LP links wire contract", () => {
  it("lists issued links with in-range counters", async () => {
    const api = demoLpApi();
    const range = rangeForDays(30);
    const { items } = await api.listLinks(range);

    expect(items.length).toBeGreaterThan(1);
    const instagram = items.find((l) => l.slug === "instagram");
    expect(instagram).toBeTruthy();
    expect(instagram!.url).toBe(buildTrackingUrl("instagram"));
    expect(instagram!.stats.visits).toBeGreaterThan(0);
    // のべ >= 一意。逆なら集計が壊れている。
    expect(instagram!.stats.visits).toBeGreaterThanOrEqual(instagram!.stats.uniques);
    expect(instagram!.stats.lastVisitAt).toBeTruthy();
    // 停止中の行も一覧から消えない（集計を残す）。
    expect(items.some((l) => !l.active)).toBe(true);
  });

  it("issues a new link with zero counters and rejects a duplicate slug", async () => {
    const api = demoLpApi();
    const range = rangeForDays(30);
    const created = await api.createLink({ name: "TikTok 告知", slug: "tiktok" }, range);

    expect(created.url).toBe(buildTrackingUrl("tiktok"));
    expect(created.active).toBe(true);
    // 発行直後は 0 件（デモでも訪問を捏造しない）。
    expect(created.stats).toEqual({ visits: 0, uniques: 0, lastVisitAt: null });

    const after = await api.listLinks(range);
    expect(after.items.some((l) => l.slug === "tiktok")).toBe(true);

    await expect(api.createLink({ name: "TikTok 2", slug: "tiktok" }, range)).rejects.toThrow();
  });

  it("pauses and resumes a link without dropping its counters", async () => {
    const api = demoLpApi();
    const range = rangeForDays(30);
    const before = (await api.listLinks(range)).items.find((l) => l.slug === "instagram")!;

    const paused = await api.setLinkActive({ id: before.id, active: false }, range);
    expect(paused.active).toBe(false);
    expect(paused.stats.visits).toBe(before.stats.visits);

    const resumed = await api.setLinkActive({ id: before.id, active: true }, range);
    expect(resumed.active).toBe(true);
  });
});

describe("LpLinksScreen", () => {
  it("renders the issue form and the issued links from the demo transport", async () => {
    render(wrap(demoLpApi()));

    expect(screen.getByTestId("fe2-lp-links-loading")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("fe2-lp-links-table")).toBeInTheDocument());

    const table = screen.getByTestId("fe2-lp-links-table");
    expect(within(table).getByText("Instagram")).toBeInTheDocument();
    // 発行済みの URL が全文（パラメータつき）で読める。
    expect(screen.getByTestId("fe2-lp-link-url-instagram")).toHaveTextContent(buildTrackingUrl("instagram"));
    expect(screen.getByTestId("fe2-lp-link-copy-instagram")).toBeInTheDocument();
    // タブ帯（バージョン / 流入URL / ログ管理）が出ている。
    expect(screen.getByTestId("fe2-lp-tabs")).toBeInTheDocument();
  });

  it("previews the url while typing and issues it into the list", async () => {
    const user = userEvent.setup();
    render(wrap(demoLpApi()));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-links-table")).toBeInTheDocument());

    await user.type(screen.getByTestId("fe2-lp-link-name"), "TikTok 告知");
    // 名前からパラメータ値が下書きされ、発行される URL が押す前に見える。
    await waitFor(() => expect(screen.getByTestId("fe2-lp-link-preview")).toHaveTextContent(buildTrackingUrl("tiktok")));

    await user.click(screen.getByTestId("fe2-lp-link-submit"));

    await waitFor(() => expect(screen.getByTestId("fe2-lp-link-url-tiktok")).toBeInTheDocument());
    expect(screen.getByTestId("fe2-lp-link-url-tiktok")).toHaveTextContent(buildTrackingUrl("tiktok"));
    // 発行後はフォームが空に戻る（同じ値を二重発行させない）。
    expect(screen.getByTestId("fe2-lp-link-name")).toHaveValue("");
  });

  it("blocks a duplicate param value before calling the api", async () => {
    const user = userEvent.setup();
    const api = demoLpApi();
    const createSpy = vi.spyOn(api, "createLink");
    render(wrap(api));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-links-table")).toBeInTheDocument());

    await user.type(screen.getByTestId("fe2-lp-link-name"), "インスタ再掲");
    await user.type(screen.getByTestId("fe2-lp-link-slug"), "instagram");
    await user.click(screen.getByTestId("fe2-lp-link-submit"));

    expect(await screen.findByText(/既に発行済み/)).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("rolls the list back when issuing fails", async () => {
    const user = userEvent.setup();
    const api = demoLpApi();
    vi.spyOn(api, "createLink").mockRejectedValue(new Error("boom"));
    render(wrap(api));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-links-table")).toBeInTheDocument());

    await user.type(screen.getByTestId("fe2-lp-link-name"), "LinkedIn 告知");
    await user.click(screen.getByTestId("fe2-lp-link-submit"));

    // 楽観挿入された行が消え、エラートーストが出る。
    await waitFor(() => expect(screen.queryByTestId("fe2-lp-link-url-linkedin")).not.toBeInTheDocument());
    expect(await screen.findByText("流入URLを発行できませんでした")).toBeInTheDocument();
  });

  it("shows the empty state (not a blank screen) when nothing is issued yet", async () => {
    const api: LpApi = {
      ...demoLpApi(),
      listLinks: () => Promise.resolve({ items: [] }),
    };
    render(wrap(api));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-links-empty")).toBeInTheDocument());
    expect(screen.getByText("まだ流入URLがありません")).toBeInTheDocument();
  });

  it("shows a retryable error state when the list fails", async () => {
    const api: LpApi = {
      ...demoLpApi(),
      listLinks: () => Promise.reject(new Error("boom")),
    };
    render(wrap(api));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-links-error")).toBeInTheDocument());
  });
});
