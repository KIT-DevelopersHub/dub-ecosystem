// LP管理 → 公開設定 tests（下書きの自動保存・本番の一括反映・確認ダイアログ・権限・409）。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import { lp, type identity } from "@dub/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { ApiError, createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { LpSiteConfigScreen, PUBLISH_CONFIRM_TITLE } from "./LpSiteConfigScreen.tsx";
import { createLpApi, type LpApi, type LpSiteConfig, type LpSiteConfigState, type LpTicketsState } from "./lpApi.tsx";
import { LpApiProvider } from "./LpProvider.tsx";
import { diffSiteConfig, draftPreviewUrl, releasePreviewUrl, setRelease, setSection } from "./lpSiteConfig.ts";
import { miniPreviewSrc, parseLayoutReport, placeBlocks } from "./LpSectionEditor.tsx";
import { LP_PUBLIC_URL } from "./lpPublish.ts";
import { STALE_MESSAGE } from "./lpSiteConfigHooks.ts";

const nav = vi.hoisted(() => ({ navigate: vi.fn(), searchStr: "" }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => nav.navigate,
  useRouterState: ({ select }: { select: (s: { location: { searchStr: string } }) => unknown }) =>
    select({ location: { searchStr: nav.searchStr } }),
}));

const PUBLISHER = editorPermissions("lp", ["lp:publish"]);
const EDITOR = editorPermissions("lp");

const RELEASE = { versionId: "v3.4", ticketsEnabled: false, ticketsCtaEnabled: false, proposalsEnabled: false };
const BASE: LpSiteConfig = { layout: lp.defaultLayout(), release: RELEASE };

function siteState(over: Partial<LpSiteConfigState> = {}): LpSiteConfigState {
  return {
    site: "hokuriku-it-conf.com",
    draft: structuredClone(BASE),
    published: structuredClone(BASE),
    revision: 3,
    draftUpdatedAt: null,
    draftUpdatedBy: null,
    publishedAt: "2026-11-02T05:05:00.000Z",
    publishedBy: "usr_1",
    ...over,
  };
}

function fakeApi(overrides: Partial<LpApi> = {}): LpApi {
  const unused = vi.fn(() => Promise.reject(new Error("unused")));
  return {
    getStats: unused,
    getSiteTraffic: unused,
    listVisits: unused,
    listLinks: unused,
    createLink: unused,
    setLinkActive: unused,
    getPublish: unused,
    setPublish: unused,
    getTickets: () => Promise.resolve({ enabled: false, previewCheckout: false } as LpTicketsState),
    setTicketsEnabled: unused,
    setTicketsCta: unused,
    saveTicketFields: unused,
    createTicketType: unused,
    updateTicketType: unused,
    listTicketOrders: unused,
    exportTicketOrders: async () => new Blob(["x"]),
    approveTicketOrder: unused,
    listTicketCoupons: unused,
    createTicketCoupon: unused,
    setTicketCouponActive: unused,
    createTicketPreviewToken: unused,
    getProposals: unused,
    setProposalsEnabled: unused,
    saveProposalFields: unused,
    listProposals: unused,
    setProposalStatus: unused,
    getSiteConfig: () => Promise.resolve(siteState()),
    saveSiteConfigDraft: ({ config, revision }) => Promise.resolve(siteState({ draft: config, revision: revision + 1 })),
    resetSiteConfigDraft: () => Promise.resolve(siteState({ revision: 4 })),
    publishSiteConfig: ({ config, revision }) => Promise.resolve(siteState({ published: config, revision: revision + 1 })),
    ...overrides,
  };
}

function renderScreen(api: LpApi = fakeApi(), permissions: readonly identity.PermissionKey[] = PUBLISHER): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <FakeAuthProvider permissions={permissions}>
          <LpApiProvider value={api}>
            <LpSiteConfigScreen />
          </LpApiProvider>
        </FakeAuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const conflict = () =>
  new ApiError(409, { error: { code: "CONFLICT", message: "公開設定が他の操作で更新されています", retryable: false } });

beforeEach(() => {
  nav.navigate.mockReset();
  nav.searchStr = "";
});

describe("lpSiteConfig (pure)", () => {
  it("diffs the release and every registry section, in registry order", () => {
    const next = setSection(setRelease(BASE, "ticketsEnabled", true), "join", { visible: false });
    const withBanner = setSection(next, "header", { option: { key: "banner", value: false } });
    expect(diffSiteConfig(BASE, withBanner).map((d) => [d.label, d.from, d.to])).toEqual([
      ["チケット販売", "停止", "公開"],
      ["ヘッダー: 帯（告知バナー）を表示", "表示", "非表示"],
      ["参加・登壇 (Join)", "表示", "非表示"],
    ]);
    expect(diffSiteConfig(BASE, structuredClone(BASE))).toEqual([]);
  });

  it("builds the draft preview URL from the draft release + &config=draft", () => {
    const url = draftPreviewUrl(setRelease(BASE, "proposalsEnabled", true));
    expect(url).toMatch(/\?version=3\.4&tickets=off&proposals=on&config=draft$/);
  });
});

describe("LpSiteConfigScreen — プレビュー（下書き）", () => {
  it("shows card skeletons while loading", () => {
    renderScreen(fakeApi({ getSiteConfig: () => new Promise(() => {}) }));
    expect(screen.getByTestId("fe2-lp-config-loading")).toBeInTheDocument();
  });

  it("renders the release card and one card per registry section; non-hideable sections cannot be hidden", async () => {
    renderScreen();
    expect(await screen.findByTestId("fe2-lp-config-release")).toBeInTheDocument();
    for (const id of lp.LP_SECTION_IDS) expect(screen.getByTestId(`fe2-lp-config-section-${id}`)).toBeInTheDocument();
    expect(screen.getByTestId("fe2-lp-config-header-banner")).toBeChecked();
    expect(screen.getByTestId("fe2-lp-config-header-visible")).toBeDisabled();
    expect(screen.getByTestId("fe2-lp-config-footer-visible")).toBeDisabled();
    expect(screen.getByTestId("fe2-lp-config-join-visible")).not.toBeDisabled();
    expect(screen.getByTestId("fe2-lp-config-env-draft")).toHaveAttribute("aria-selected", "true");
  });

  it("クラファン情報: picks the pattern (現状のページ / 支援者情報); disabled while the section is hidden", async () => {
    const save = vi.fn(({ config, revision }: { config: LpSiteConfig; revision: number }) =>
      Promise.resolve(siteState({ draft: config, revision: revision + 1 })),
    );
    renderScreen(fakeApi({ saveSiteConfigDraft: save }));
    const current = await screen.findByTestId("fe2-lp-config-crowdfunding-pattern-current");
    expect(current).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByTestId("fe2-lp-config-crowdfunding-pattern-supporters"));
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith({
        config: setSection(BASE, "crowdfunding", { option: { key: "pattern", value: "supporters" } }),
        revision: 3,
      }),
    );
    fireEvent.click(screen.getByTestId("fe2-lp-config-crowdfunding-visible"));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-config-crowdfunding-pattern-current")).toBeDisabled());
  });

  it("switches environment through the URL (?env=live)", async () => {
    renderScreen();
    fireEvent.click(await screen.findByTestId("fe2-lp-config-env-live"));
    expect(nav.navigate).toHaveBeenCalledWith({ to: "/lp", search: { env: "live" }, replace: true });
  });

  it("autosaves each change optimistically with the current revision (no dialog)", async () => {
    const save = vi.fn(({ config, revision }: { config: LpSiteConfig; revision: number }) =>
      Promise.resolve(siteState({ draft: config, revision: revision + 1 })),
    );
    renderScreen(fakeApi({ saveSiteConfigDraft: save }));
    fireEvent.click(await screen.findByTestId("fe2-lp-config-join-visible"));
    expect(screen.getByTestId("fe2-lp-config-join-visible")).not.toBeChecked();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].revision).toBe(3);
    expect(save.mock.calls[0]![0].config.layout.sections.join?.visible).toBe(false);
    // 2 回目は 1 回目の応答の revision で送る（直列キュー）。
    fireEvent.click(screen.getByTestId("fe2-lp-config-proposalsEnabled"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![0].revision).toBe(4);
    expect(save.mock.calls[1]![0].config.release.proposalsEnabled).toBe(true);
    expect(save.mock.calls[1]![0].config.layout.sections.join?.visible).toBe(false);
  });

  it("rolls the draft back and toasts when the save fails", async () => {
    let calls = 0;
    renderScreen(
      fakeApi({
        getSiteConfig: () => Promise.resolve(siteState({ revision: 3 + calls })),
        saveSiteConfigDraft: () => {
          calls += 1;
          return Promise.reject(new Error("boom"));
        },
      }),
    );
    fireEvent.click(await screen.findByTestId("fe2-lp-config-join-visible"));
    expect(screen.getByTestId("fe2-lp-config-join-visible")).not.toBeChecked();
    expect(await screen.findByText("下書きを保存できませんでした")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("fe2-lp-config-join-visible")).toBeChecked());
  });

  it("409: refetches the latest state and explains why", async () => {
    const latest = siteState({ revision: 9, draft: setSection(BASE, "about", { visible: false }) });
    const get = vi.fn().mockResolvedValueOnce(siteState()).mockResolvedValue(latest);
    renderScreen(fakeApi({ getSiteConfig: get, saveSiteConfigDraft: () => Promise.reject(conflict()) }));
    fireEvent.click(await screen.findByTestId("fe2-lp-config-join-visible"));
    expect(await screen.findByText(STALE_MESSAGE)).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-config-about-visible")).not.toBeChecked());
    expect(screen.getByTestId("fe2-lp-config-join-visible")).toBeChecked();
  });

  it("opens the draft preview (&config=draft) in the in-app viewer", async () => {
    const draft = setRelease(BASE, "versionId", "v3.5");
    renderScreen(fakeApi({ getSiteConfig: () => Promise.resolve(siteState({ draft })) }));
    await screen.findByTestId("fe2-lp-config-release");
    fireEvent.click(screen.getByTestId("fe2-lp-config-preview-open"));
    await waitFor(() =>
      expect(screen.getByTestId("fe2-lp-viewer-frame")).toHaveAttribute("src", draftPreviewUrl(draft)),
    );
  });

  it("never writes production from the draft tab, and has no manual 「プレビューに反映」 (the preview follows instantly)", async () => {
    const draft = setSection(BASE, "vision", { visible: false });
    const publish = vi.fn();
    renderScreen(fakeApi({ getSiteConfig: () => Promise.resolve(siteState({ draft })), publishSiteConfig: publish }));
    await screen.findByTestId("fe2-lp-config-release");
    expect(screen.queryByTestId("fe2-lp-config-publish")).toBeNull();
    expect(screen.queryByText(/本番へ反映/)).toBeNull();
    expect(screen.queryByTestId("fe2-lp-config-apply-preview")).toBeNull();
    expect(screen.queryByTestId("fe2-lp-config-publish-dialog")).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  it("本番タブで確かめる carries the draft to the live tab as staged changes without writing", async () => {
    const draft = setSection(BASE, "vision", { visible: false });
    const publish = vi.fn();
    const save = vi.fn();
    nav.navigate.mockClear();
    renderScreen(
      fakeApi({ getSiteConfig: () => Promise.resolve(siteState({ draft })), publishSiteConfig: publish, saveSiteConfigDraft: save }),
    );
    fireEvent.click(await screen.findByTestId("fe2-lp-config-to-live"));
    expect(nav.navigate).toHaveBeenCalledWith({ to: "/lp", search: { env: "live" }, replace: true });
    expect(publish).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("a viewer sees everything disabled", async () => {
    renderScreen(fakeApi(), viewerPermissions("lp"));
    expect(await screen.findByTestId("fe2-lp-config-join-visible")).toBeDisabled();
    expect(screen.getByTestId("fe2-lp-config-version")).toBeDisabled();
  });
});

describe("LpSiteConfigScreen — 本番", () => {
  beforeEach(() => {
    nav.searchStr = "?env=live";
  });

  it("stages changes locally, counts them and shows the diff without calling the api", async () => {
    const api = fakeApi({ saveSiteConfigDraft: vi.fn(), publishSiteConfig: vi.fn() });
    renderScreen(api);
    expect(await screen.findByTestId("fe2-lp-config-live-banner")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-lp-config-change-count")).toHaveTextContent("変更 0 件");
    fireEvent.click(screen.getByTestId("fe2-lp-config-join-visible"));
    fireEvent.click(screen.getByTestId("fe2-lp-config-proposalsEnabled"));
    expect(screen.getByTestId("fe2-lp-config-change-count")).toHaveTextContent("変更 2 件");
    expect(screen.getByTestId("fe2-lp-config-staged-diff-proposalsEnabled")).toHaveTextContent("登壇者募集停止募集中");
    // 元に戻すと件数も 0 に戻る。
    fireEvent.click(screen.getByTestId("fe2-lp-config-join-visible"));
    expect(screen.getByTestId("fe2-lp-config-change-count")).toHaveTextContent("変更 1 件");
    expect(api.saveSiteConfigDraft).not.toHaveBeenCalled();
    expect(api.publishSiteConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("fe2-lp-config-discard"));
    expect(screen.getByTestId("fe2-lp-config-change-count")).toHaveTextContent("変更 0 件");
  });

  it("publishes all staged changes in one request after the production confirm", async () => {
    const publish = vi.fn(({ config, revision }: { config: LpSiteConfig; revision: number }) =>
      Promise.resolve(siteState({ published: config, revision: revision + 1 })),
    );
    renderScreen(fakeApi({ publishSiteConfig: publish }));
    fireEvent.click(await screen.findByTestId("fe2-lp-config-join-visible"));
    fireEvent.click(screen.getByTestId("fe2-lp-config-proposalsEnabled"));
    fireEvent.click(screen.getByTestId("fe2-lp-config-publish"));
    const dialog = await screen.findByTestId("fe2-lp-config-publish-dialog");
    expect(within(dialog).getByText(PUBLISH_CONFIRM_TITLE)).toBeInTheDocument();
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
    expect(within(dialog).queryByTestId("fe2-lp-config-tickets-ack")).toBeNull();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "本番に反映する" }));
    });
    expect(publish).toHaveBeenCalledTimes(1);
    const sent = publish.mock.calls[0]![0];
    expect(sent.revision).toBe(3);
    expect(sent.config.release.proposalsEnabled).toBe(true);
    expect(sent.config.layout.sections.join?.visible).toBe(false);
    await waitFor(() => expect(screen.getByTestId("fe2-lp-config-change-count")).toHaveTextContent("変更 0 件"));
    expect(screen.getByTestId("fe2-lp-config-proposalsEnabled")).toBeChecked();
  });

  it("requires the acknowledgement when the batch turns ticket sales on", async () => {
    const publish = vi.fn(({ config }: { config: LpSiteConfig }) => Promise.resolve(siteState({ published: config, revision: 4 })));
    renderScreen(fakeApi({ publishSiteConfig: publish }));
    fireEvent.click(await screen.findByTestId("fe2-lp-config-ticketsEnabled"));
    fireEvent.click(screen.getByTestId("fe2-lp-config-publish"));
    const dialog = await screen.findByTestId("fe2-lp-config-publish-dialog");
    expect(within(dialog).getByTestId("fe2-lp-config-tickets-warning")).toHaveTextContent("インターネット上の誰でも");
    const confirm = within(dialog).getByRole("button", { name: "本番に反映する" });
    expect(confirm).toBeDisabled();
    fireEvent.click(within(dialog).getByTestId("fe2-lp-config-tickets-ack"));
    expect(confirm).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("409 on publish: keeps the staged changes, refetches and explains", async () => {
    const get = vi.fn().mockResolvedValue(siteState());
    renderScreen(fakeApi({ getSiteConfig: get, publishSiteConfig: () => Promise.reject(conflict()) }));
    fireEvent.click(await screen.findByTestId("fe2-lp-config-join-visible"));
    fireEvent.click(screen.getByTestId("fe2-lp-config-publish"));
    const dialog = await screen.findByTestId("fe2-lp-config-publish-dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "本番に反映する" }));
    });
    expect(await screen.findByText(STALE_MESSAGE)).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("fe2-lp-config-change-count")).toHaveTextContent("変更 1 件");
  });

  it("without lp:publish every production control is disabled", async () => {
    renderScreen(fakeApi(), EDITOR);
    expect(await screen.findByTestId("fe2-lp-config-live-banner")).toHaveTextContent("lp:publish");
    expect(screen.getByTestId("fe2-lp-config-ticketsEnabled")).toBeDisabled();
    expect(screen.getByTestId("fe2-lp-config-join-visible")).toBeDisabled();
    expect(screen.getByTestId("fe2-lp-config-publish")).toBeDisabled();
  });
});

describe("LpSiteConfigScreen — 上部の操作帯とミニプレビュー", () => {
  it("puts every action, the preview button and the live LP link in the sticky top bar", async () => {
    renderScreen();
    await screen.findByTestId("fe2-lp-config-release");
    const bar = screen.getByTestId("fe2-lp-config-actionbar");
    for (const id of ["fe2-lp-config-env", "fe2-lp-config-preview-open", "fe2-lp-config-reset", "fe2-lp-config-to-live"]) {
      expect(within(bar).getByTestId(id)).toBeInTheDocument();
    }
    expect(within(bar).getByTestId("fe2-lp-config-live-url")).toHaveAttribute("href", LP_PUBLIC_URL);
  });

  it("live: the change count, discard and publish are in the top bar too", async () => {
    nav.searchStr = "?env=live";
    renderScreen();
    await screen.findByTestId("fe2-lp-config-release");
    const bar = screen.getByTestId("fe2-lp-config-actionbar");
    for (const id of ["fe2-lp-config-change-count", "fe2-lp-config-discard", "fe2-lp-config-publish", "fe2-lp-config-live-url"]) {
      expect(within(bar).getByTestId(id)).toBeInTheDocument();
    }
    expect(within(bar).queryByTestId("fe2-lp-config-preview-open")).toBeNull();
  });

  it("draft: the mini preview shows the saved draft and reloads after each autosave", async () => {
    renderScreen();
    const frame = await screen.findByTestId("fe2-lp-config-mini-frame");
    expect(frame).toHaveAttribute("src", miniPreviewSrc(draftPreviewUrl(BASE), 3));
    expect(screen.getByTestId("fe2-lp-config-mini-loading")).toBeInTheDocument();
    fireEvent.load(frame);
    expect(screen.queryByTestId("fe2-lp-config-mini-loading")).toBeNull();
    fireEvent.click(screen.getByTestId("fe2-lp-config-join-visible"));
    await waitFor(() => expect(frame).toHaveAttribute("src", miniPreviewSrc(draftPreviewUrl(BASE), 4)), { timeout: 4000 });
  });

  it("live: staged release changes are previewed via URL; staged section changes get a note", async () => {
    nav.searchStr = "?env=live";
    renderScreen();
    const frame = await screen.findByTestId("fe2-lp-config-mini-frame");
    expect(frame).toHaveAttribute("src", `${releasePreviewUrl(BASE)}&config=live`);
    fireEvent.click(screen.getByTestId("fe2-lp-config-proposalsEnabled"));
    await waitFor(
      () => expect(frame).toHaveAttribute("src", `${releasePreviewUrl(setRelease(BASE, "proposalsEnabled", true))}&config=live`),
      { timeout: 4000 },
    );
    fireEvent.click(screen.getByTestId("fe2-lp-config-join-visible"));
    // 即時反映できない（古い橋渡しの）LP のときだけの注記。
    const notes = () => screen.getAllByTestId("fe2-lp-config-mini-note").map((n) => n.textContent).join("\n");
    expect(notes()).toContain("本番に反映するとプレビューに映ります");
  });

  it("live: with an instant-capable LP, staged section changes are sent to the preview and the note goes away", async () => {
    nav.searchStr = "?env=live";
    renderScreen();
    const frame = (await screen.findByTestId("fe2-lp-config-mini-frame")) as HTMLIFrameElement;
    const origin = new URL(frame.getAttribute("src")!).origin;
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    fireEvent.load(frame);
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "lp:sections", sections: [], docHeight: 900, caps: ["config"] }, origin, source: frame.contentWindow }),
      );
    });
    fireEvent.click(screen.getByTestId("fe2-lp-config-join-visible"));
    expect(post).toHaveBeenCalledWith({ type: "lp:config", attrs: { "data-lp-s-join": "off" } }, origin);
    expect(screen.queryByText(/本番に反映するとプレビューに映ります/)).toBeNull();
  });

  it("narrow screens stack the settings and open the preview from the card header", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes("1100px"),
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      renderScreen();
      await screen.findByTestId("fe2-lp-config-release");
      expect(screen.getByTestId("fe2-lp-config-settings")).toHaveAttribute("data-layout", "stacked");
      expect(screen.getByTestId("fe2-lp-config-mini")).not.toBeVisible();
      fireEvent.click(screen.getByTestId("fe2-lp-config-mini-toggle"));
      expect(screen.getByTestId("fe2-lp-config-mini")).toBeVisible();
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("LpSectionEditor (pure)", () => {
  it("accepts only a full layout report (old bridges without heights are not aligned)", () => {
    expect(parseLayoutReport({ sections: [{ id: "header", top: 0 }] })).toBeNull();
    expect(parseLayoutReport({ sections: [{ id: "header", top: 0, height: 900 }], docHeight: 5000 })).toEqual({
      sections: [{ id: "header", top: 0, height: 900 }],
      docHeight: 5000,
    });
    expect(parseLayoutReport({ sections: [], docHeight: 1e9 })?.docHeight).toBe(40000);
  });

  it("places each block at its section, pushes overlapping blocks down and stacks hidden sections under the previous one", () => {
    const report = {
      sections: [
        { id: "header", top: 0, height: 900 },
        { id: "program", top: 1000, height: 200 },
        { id: "about", top: 1200, height: 800 },
      ],
      docHeight: 2000,
    };
    const tops = placeBlocks(["header", "join", "program", "about"], report, 0.5, { header: 100, join: 100, program: 150, about: 50 }, 10);
    // header: 0 / join（非表示）: header のすぐ下 / program: 500 / about: 600 は program と重なるので 660 へ。
    expect(tops).toEqual({ header: 0, join: 110, program: 500, about: 660 });
  });
});

describe("LpSiteConfigScreen — LP（左）とセクションの設定（右）を 1 枚に", () => {
  async function setup() {
    renderScreen();
    const frame = (await screen.findByTestId("fe2-lp-config-mini-frame")) as HTMLIFrameElement;
    const origin = new URL(frame.getAttribute("src")!).origin;
    const win = frame.contentWindow!;
    const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});
    const fromLp = (data: unknown, o = origin, source: Window | null = win) =>
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data, origin: o, source }));
      });
    return { frame, origin, post, fromLp };
  }
  const REPORT = {
    type: "lp:sections",
    sections: [
      { id: "header", top: 0, height: 900 },
      { id: "join", top: 900, height: 600 },
      { id: "program", top: 1500, height: 1000 },
    ],
    docHeight: 3000,
  };

  it("is one card: the preview on the left, the section settings on the right", async () => {
    renderScreen();
    const card = await screen.findByTestId("fe2-lp-config-editor");
    const mini = within(card).getByTestId("fe2-lp-config-mini");
    const settings = within(card).getByTestId("fe2-lp-config-settings");
    expect(mini.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const id of lp.LP_SECTION_IDS) expect(within(settings).getByTestId(`fe2-lp-config-section-${id}`)).toBeInTheDocument();
  });

  it("asks the LP for full height + select mode, then draws it at full height and aligns each block to its section", async () => {
    const { frame, origin, post, fromLp } = await setup();
    fireEvent.load(frame);
    expect(post).toHaveBeenCalledWith({ type: "lp:hello", select: true, fit: 900 }, origin);
    expect(screen.getByTestId("fe2-lp-config-settings")).toHaveAttribute("data-layout", "stacked");
    fromLp(REPORT);
    expect(screen.getByTestId("fe2-lp-config-settings")).toHaveAttribute("data-layout", "aligned");
    // jsdom は幅 0 なので縮尺 0.4。iframe は LP の全高・枠は全高 × 縮尺（中でスクロールしない）。
    expect(frame.style.height).toBe("3000px");
    expect(frame).toHaveAttribute("scrolling", "no");
    expect(screen.getByTestId("fe2-lp-config-mini-box").style.height).toBe("1200px");
    const top = (id: string) => (document.querySelector(`[data-lp-block="${id}"]`) as HTMLElement).style.top;
    expect([top("header"), top("join"), top("program")]).toEqual(["0px", "360px", "600px"]);
    // 各設定は次の設定の手前までの帯の中で貼り付く。
    expect((document.querySelector('[data-lp-block="header"]') as HTMLElement).style.height).toBe("344px");
  });

  it("hovering a block outlines the section in the LP; clicking a section in the LP picks its block", async () => {
    const { frame, origin, post, fromLp } = await setup();
    fireEvent.load(frame);
    fromLp(REPORT);
    fireEvent.mouseEnter(screen.getByRole("group", { name: "プログラム" }));
    expect(post).toHaveBeenCalledWith({ type: "lp:mark", section: "program" }, origin);
    fromLp({ type: "lp:select", section: "crowdfunding" }, "https://evil.example");
    fromLp({ type: "lp:select", section: "crowdfunding" }, undefined, window);
    fromLp({ type: "lp:select", section: "not-a-section" });
    expect(screen.getByTestId("fe2-lp-config-settings")).toHaveAttribute("data-active-section", "program");
    fromLp({ type: "lp:select", section: "crowdfunding" });
    expect(screen.getByTestId("fe2-lp-config-settings")).toHaveAttribute("data-active-section", "crowdfunding");
    // 保存で読み直した LP には、選んでいるセクションの枠を付け直す。
    post.mockClear();
    fromLp(REPORT);
    expect(post).toHaveBeenCalledWith({ type: "lp:mark", section: "crowdfunding" }, origin);
  });

  it("instant: switching a section sends the new data-lp-* attributes to the LP at once (no reload)", async () => {
    const { frame, origin, post, fromLp } = await setup();
    const src = frame.getAttribute("src");
    fireEvent.load(frame);
    fromLp({ ...REPORT, caps: ["config"] });
    // 読み込み直後に画面上の設定を当て直す（保存済みと同じでも送る = demo でも映る）。
    expect(post).toHaveBeenCalledWith({ type: "lp:config", attrs: {} }, origin);
    expect(screen.getByTestId("fe2-lp-config-editor").querySelector("[data-live-config]")).toHaveAttribute("data-live-config", "true");
    post.mockClear();
    fireEvent.click(screen.getByTestId("fe2-lp-config-join-visible"));
    expect(post).toHaveBeenCalledWith({ type: "lp:config", attrs: { "data-lp-s-join": "off" } }, origin);
    // LP が付け替えて送り直した lp:sections では同じ属性を送り直さない（ループしない）。
    post.mockClear();
    fromLp({ ...REPORT, caps: ["config"] });
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "lp:config" }), origin);
    // 保存（revision）で読み直さない。
    await act(() => new Promise((r) => setTimeout(r, 700)));
    expect(frame.getAttribute("src")).toBe(src);
  });

  it("legacy bridge (no caps): does not send lp:config and reloads after the save instead", async () => {
    const { frame, post, fromLp } = await setup();
    const src = frame.getAttribute("src");
    fireEvent.load(frame);
    fromLp(REPORT);
    fireEvent.click(screen.getByTestId("fe2-lp-config-join-visible"));
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "lp:config" }), expect.anything());
    await waitFor(() => expect(frame.getAttribute("src")).not.toBe(src), { timeout: 2000 });
  });

  it("an LP that does not report its layout gets a scrolling preview and stacked settings, with a note", async () => {
    const { frame } = await setup();
    fireEvent.load(frame);
    expect(await screen.findByTestId("fe2-lp-config-mini-nosync", undefined, { timeout: 4500 })).toHaveTextContent("v3.6");
    expect(screen.getByTestId("fe2-lp-config-settings")).toHaveAttribute("data-layout", "stacked");
    expect(frame).not.toHaveAttribute("scrolling");
  });
});

describe("demo transport serves /lp/site-config", () => {
  it("saves the draft (409 on stale revision) and publishing writes the release into tickets / proposals / publish", async () => {
    const api = createLpApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() }));
    const s0 = await api.getSiteConfig();
    expect(s0.draft).toEqual(s0.published);
    const draft = setRelease(setSection(s0.draft, "join", { visible: false }), "proposalsEnabled", true);
    const s1 = await api.saveSiteConfigDraft({ config: draft, revision: s0.revision });
    expect(s1.revision).toBe(s0.revision + 1);
    expect(s1.draft.layout.sections.join?.visible).toBe(false);
    await expect(api.saveSiteConfigDraft({ config: draft, revision: s0.revision })).rejects.toMatchObject({ status: 409 });
    const live = setRelease(setRelease(draft, "ticketsEnabled", true), "versionId", "v3.5");
    const s2 = await api.publishSiteConfig({ config: live, revision: s1.revision });
    expect(s2.published.release).toEqual({ ...live.release });
    expect((await api.getTickets()).enabled).toBe(true);
    expect((await api.getProposals()).enabled).toBe(true);
    expect((await api.getPublish()).versionId).toBe("v3.5");
    const s3 = await api.resetSiteConfigDraft({ revision: s2.revision });
    expect(s3.draft).toEqual(s3.published);
  });
});
