// LP管理 → プレビュー tests.
// 版・チケット販売あり/なし・登壇者募集あり/なしを選んで「プレビューを開く」と、その条件の URL を
// LP ビューアで開く。何も保存しない（公開・販売・募集の API は呼ばない）。
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import { describe, expect, it, vi } from "vitest";
import { FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { LpPreviewScreen } from "./LpPreviewScreen.tsx";
import type { LpApi, LpProposalsState, LpPublishState, LpTicketsState } from "./lpApi.tsx";
import { LpApiProvider } from "./LpProvider.tsx";
import { lpPreviewUrl } from "./lpPublish.ts";

const nav = vi.hoisted(() => ({ navigate: vi.fn(), back: vi.fn(), searchStr: "" }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => nav.navigate,
  useRouter: () => ({ history: { back: nav.back } }),
  useRouterState: ({ select }: { select: (s: { location: { searchStr: string } }) => unknown }) =>
    select({ location: { searchStr: nav.searchStr } }),
}));

const PUBLISH: LpPublishState = {
  site: "hokuriku-it-conf.com",
  versionId: "v3.4",
  versions: ["v3.5", "v3.4", "v3.3"],
  updatedAt: null,
  updatedBy: null,
};

function fakeApi(overrides: Partial<LpApi> = {}): LpApi {
  const unused = vi.fn(() => Promise.reject(new Error("unused")));
  return {
    getStats: unused,
    getSiteTraffic: unused,
    listVisits: unused,
    listLinks: unused,
    createLink: unused,
    setLinkActive: unused,
    getTickets: () => Promise.resolve({ enabled: false } as LpTicketsState),
    setTicketsEnabled: unused,
    setTicketsCta: unused,
    saveTicketFields: unused,
    createTicketType: unused,
    updateTicketType: unused,
    listTicketOrders: unused,
    createTicketPreviewToken: unused,
    getProposals: () => Promise.resolve({ enabled: true } as LpProposalsState),
    setProposalsEnabled: unused,
    saveProposalFields: unused,
    listProposals: unused,
    setProposalStatus: unused,
    getPublish: () => Promise.resolve(PUBLISH),
    setPublish: unused,
    ...overrides,
  };
}

function renderScreen(api: LpApi = fakeApi()): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <FakeAuthProvider permissions={viewerPermissions("lp")}>
          <LpApiProvider value={api}>
            <LpPreviewScreen />
          </LpApiProvider>
        </FakeAuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("lpPreviewUrl", () => {
  it("always pins the version number (never live) and carries tickets=on|off", () => {
    expect(lpPreviewUrl("v3.4", { tickets: "on", proposals: "on" }, "https://lp.example")).toBe(
      "https://lp.example/?version=3.4&tickets=on&proposals=on",
    );
    expect(lpPreviewUrl("v3.5", { tickets: "off", proposals: "off" }, "https://lp.example")).toBe(
      "https://lp.example/?version=3.5&tickets=off&proposals=off",
    );
  });

  it("adds the test-purchase token only with tickets=on", () => {
    expect(lpPreviewUrl("v3.4", { tickets: "on", proposals: "on", previewToken: "1.ab" }, "https://lp.example")).toBe(
      "https://lp.example/?version=3.4&tickets=on&proposals=on&tickets_preview=1.ab",
    );
    expect(lpPreviewUrl("v3.4", { tickets: "off", proposals: "on", previewToken: "1.ab" }, "https://lp.example")).toBe(
      "https://lp.example/?version=3.4&tickets=off&proposals=on",
    );
  });
});

describe("LpPreviewScreen", () => {
  it("shows a skeleton while loading", () => {
    renderScreen(fakeApi({ getPublish: () => new Promise(() => {}) }));
    expect(screen.getByTestId("fe2-lp-preview-loading")).toBeInTheDocument();
  });

  it("defaults to the live version with tickets on and shows the real sales state", async () => {
    renderScreen();
    const select = await screen.findByTestId("fe2-lp-preview-version");
    expect(select).toHaveValue("v3.4");
    expect(screen.getByTestId("fe2-lp-preview-tickets-on")).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByTestId("fe2-lp-preview-sales-state")).toHaveTextContent("実際の販売: 停止中");
    // 同梱されていない版は選べない。
    const v10 = within(select).getAllByRole("option").find((o) => o.getAttribute("value") === "v1.0");
    expect(v10).toBeDisabled();
  });

  it("opens the chosen version + tickets in the viewer without calling publish/sales APIs", async () => {
    const api = fakeApi();
    renderScreen(api);
    fireEvent.change(await screen.findByTestId("fe2-lp-preview-version"), { target: { value: "v3.5" } });
    fireEvent.click(screen.getByTestId("fe2-lp-preview-open"));
    expect(screen.getByTestId("fe2-lp-viewer-frame")).toHaveAttribute("src", lpPreviewUrl("v3.5", { tickets: "on", proposals: "on" }));
    expect(screen.getByTestId("fe2-lp-viewer")).toHaveAccessibleName(/チケット販売あり・登壇者募集あり・プレビュー/);

    fireEvent.click(screen.getByTestId("fe2-lp-back-button"));
    fireEvent.click(screen.getByTestId("fe2-lp-preview-tickets-off"));
    fireEvent.click(screen.getByTestId("fe2-lp-preview-open"));
    expect(screen.getByTestId("fe2-lp-viewer-frame")).toHaveAttribute("src", lpPreviewUrl("v3.5", { tickets: "off", proposals: "on" }));
    expect(api.setPublish).not.toHaveBeenCalled();
    expect(api.setTicketsEnabled).not.toHaveBeenCalled();
  });

  it("toggles 登壇者募集 independently and shows the real call state", async () => {
    const api = fakeApi();
    renderScreen(api);
    expect(await screen.findByTestId("fe2-lp-preview-proposals-state")).toHaveTextContent("実際の募集: 募集中");
    expect(screen.getByTestId("fe2-lp-preview-proposals-on")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("fe2-lp-preview-proposals-note")).toHaveTextContent("本物の応募");
    fireEvent.click(screen.getByTestId("fe2-lp-preview-proposals-off"));
    expect(screen.getByTestId("fe2-lp-preview-proposals-note")).toHaveTextContent("「準備中」のまま");
    fireEvent.click(screen.getByTestId("fe2-lp-preview-open"));
    expect(screen.getByTestId("fe2-lp-viewer-frame")).toHaveAttribute(
      "src",
      lpPreviewUrl("v3.4", { tickets: "on", proposals: "off" }),
    );
    expect(screen.getByTestId("fe2-lp-viewer")).toHaveAccessibleName(/登壇者募集なし・プレビュー/);
    expect(api.setProposalsEnabled).not.toHaveBeenCalled();
  });

  it("pushes ?open so the browser back closes the viewer and stays on this tab", async () => {
    nav.navigate.mockClear();
    nav.back.mockClear();
    renderScreen();
    fireEvent.click(await screen.findByTestId("fe2-lp-preview-open"));
    expect(nav.navigate).toHaveBeenCalledWith({ to: "/lp/preview", search: { open: 1 } });
  });

  it("app-back pops the pushed entry, or replaces it once the LP navigated inside the frame", async () => {
    nav.searchStr = "?open=1";
    try {
      renderScreen();
      fireEvent.click(await screen.findByTestId("fe2-lp-preview-open"));
      nav.navigate.mockClear();
      fireEvent.click(screen.getByTestId("fe2-lp-back-button"));
      expect(nav.back).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("fe2-lp-viewer")).not.toBeInTheDocument();

      nav.back.mockClear();
      fireEvent.click(screen.getByTestId("fe2-lp-preview-open"));
      const frame = screen.getByTestId("fe2-lp-viewer-frame");
      fireEvent.load(frame);
      fireEvent.load(frame);
      nav.navigate.mockClear();
      fireEvent.click(screen.getByTestId("fe2-lp-back-button"));
      expect(nav.back).not.toHaveBeenCalled();
      expect(nav.navigate).toHaveBeenCalledWith({ to: "/lp/preview", replace: true });
    } finally {
      nav.searchStr = "";
    }
  });

  it("Stripe test mode + sales off: issues a test-purchase token and opens the preview with it", async () => {
    const createTicketPreviewToken = vi.fn(() => Promise.resolve({ token: "1800000000.abc", expiresAt: "2027-01-01T00:00:00Z" }));
    renderScreen(
      fakeApi({
        getTickets: () => Promise.resolve({ enabled: false, previewCheckout: true } as LpTicketsState),
        createTicketPreviewToken,
      }),
    );
    await screen.findByTestId("fe2-lp-preview-sales-state");
    expect(screen.getByText(/テスト購入まで試せます/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("fe2-lp-preview-open"));
    const frame = await screen.findByTestId("fe2-lp-viewer-frame");
    expect(createTicketPreviewToken).toHaveBeenCalledTimes(1);
    expect(frame).toHaveAttribute(
      "src",
      lpPreviewUrl("v3.4", { tickets: "on", proposals: "on", previewToken: "1800000000.abc" }),
    );
    expect(screen.getByTestId("fe2-lp-viewer")).toHaveAccessibleName(/テスト購入可/);
  });

  it("falls back to the look-only preview when the token is refused (view role / live key)", async () => {
    renderScreen(
      fakeApi({
        getTickets: () => Promise.resolve({ enabled: false, previewCheckout: true } as LpTicketsState),
        createTicketPreviewToken: () => Promise.reject(new Error("409")),
      }),
    );
    await screen.findByTestId("fe2-lp-preview-sales-state");
    fireEvent.click(screen.getByTestId("fe2-lp-preview-open"));
    expect(await screen.findByTestId("fe2-lp-viewer-frame")).toHaveAttribute(
      "src",
      lpPreviewUrl("v3.4", { tickets: "on", proposals: "on" }),
    );
  });

  it("does not ask for a token when Stripe is not in test mode", async () => {
    const createTicketPreviewToken = vi.fn();
    renderScreen(fakeApi({ createTicketPreviewToken }));
    fireEvent.click(await screen.findByTestId("fe2-lp-preview-open"));
    expect(createTicketPreviewToken).not.toHaveBeenCalled();
  });

  it("shows an error with retry when the publish state fails", async () => {
    renderScreen(fakeApi({ getPublish: () => Promise.reject(new Error("boom")) }));
    expect(await screen.findByTestId("fe2-lp-preview-error")).toBeInTheDocument();
  });
});
