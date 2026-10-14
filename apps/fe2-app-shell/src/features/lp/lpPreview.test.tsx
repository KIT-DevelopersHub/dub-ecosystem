// LP管理 → プレビュー tests.
// 版とチケット販売あり/なしを選んで「プレビューを開く」と、その条件の URL を LP ビューアで開く。
// 何も保存しない（公開・販売の API は呼ばない）。
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import { describe, expect, it, vi } from "vitest";
import { FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { LpPreviewScreen } from "./LpPreviewScreen.tsx";
import type { LpApi, LpPublishState, LpTicketsState } from "./lpApi.tsx";
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
    expect(lpPreviewUrl("v3.4", "on", "https://lp.example")).toBe("https://lp.example/?version=3.4&tickets=on");
    expect(lpPreviewUrl("v3.5", "off", "https://lp.example")).toBe("https://lp.example/?version=3.5&tickets=off");
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
    expect(screen.getByTestId("fe2-lp-viewer-frame")).toHaveAttribute("src", lpPreviewUrl("v3.5", "on"));
    expect(screen.getByTestId("fe2-lp-viewer")).toHaveAccessibleName(/チケット販売あり・プレビュー/);

    fireEvent.click(screen.getByTestId("fe2-lp-back-button"));
    fireEvent.click(screen.getByTestId("fe2-lp-preview-tickets-off"));
    fireEvent.click(screen.getByTestId("fe2-lp-preview-open"));
    expect(screen.getByTestId("fe2-lp-viewer-frame")).toHaveAttribute("src", lpPreviewUrl("v3.5", "off"));
    expect(api.setPublish).not.toHaveBeenCalled();
    expect(api.setTicketsEnabled).not.toHaveBeenCalled();
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

  it("shows an error with retry when the publish state fails", async () => {
    renderScreen(fakeApi({ getPublish: () => Promise.reject(new Error("boom")) }));
    expect(await screen.findByTestId("fe2-lp-preview-error")).toBeInTheDocument();
  });
});
