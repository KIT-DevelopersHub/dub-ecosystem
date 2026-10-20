// LP管理 → バージョン一覧 tests.
// 説明文は畳んで 1 行表示し、「詳細」を押した版だけ説明と PR リンクを出す。
// 「公開中」バッジはサーバーの公開フラグが正。版の切り替えは「本番公開」タブ（lpPublishTab.test.tsx）。
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { identity } from "@dub/types";
import { describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider } from "../../auth/test-support.tsx";
import { createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { LpManagementScreen } from "./LpManagementScreen.tsx";
import { createLpApi, type LpApi, type LpPublishState } from "./lpApi.tsx";
import { LpApiProvider } from "./LpProvider.tsx";
import { lpViewUrl } from "./lpPublish.ts";
import { LP_VERSIONS } from "./lpVersions.ts";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => null }));

const PUBLISHABLE = ["v3.5", "v3.4", "v3.3", "v3.2", "v3.1", "v3.0", "v2.0"];
const PUBLISHER = editorPermissions("lp", ["lp:publish"]);

function state(versionId: string): LpPublishState {
  return { site: "hokuriku-it-conf.com", versionId, versions: PUBLISHABLE, updatedAt: null, updatedBy: null };
}

function fakeApi(overrides: Partial<LpApi> = {}): LpApi {
  const unused = () => Promise.reject(new Error("unused"));
  return {
    getStats: unused,
    getSiteTraffic: unused,
    listVisits: unused,
    listLinks: unused,
    createLink: unused,
    setLinkActive: unused,
    getTickets: unused,
    setTicketsEnabled: unused,
    setTicketsCta: unused,
    saveTicketFields: unused,
    createTicketType: unused,
    updateTicketType: unused,
    listTicketOrders: unused,
    getProposals: unused,
    setProposalsEnabled: unused,
    saveProposalFields: unused,
    listProposals: unused,
    setProposalStatus: unused,
    getPublish: () => Promise.resolve(state("v3.4")),
    setPublish: ({ versionId }) => Promise.resolve(state(versionId)),
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
            <LpManagementScreen />
          </LpApiProvider>
        </FakeAuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("LpManagementScreen version list", () => {
  it("lists every version on one line with descriptions collapsed", async () => {
    renderScreen();
    await screen.findByTestId("fe2-lp-list");
    for (const v of LP_VERSIONS) {
      expect(screen.getByTestId(`fe2-lp-version-${v.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`fe2-lp-view-${v.id}`)).toBeInTheDocument();
      expect(screen.queryByText(v.description)).not.toBeInTheDocument();
    }
  });

  it("expands one version's description and PR link on 詳細", async () => {
    renderScreen();
    const current = LP_VERSIONS.find((v) => v.id === "v3.4")!;
    fireEvent.click(await screen.findByTestId("fe2-lp-details-toggle-v3.4"));
    expect(screen.getByTestId("fe2-lp-details-v3.4")).toHaveTextContent(current.description);
    expect(screen.getByRole("link", { name: "変更の PR を開く" })).toHaveAttribute("href", current.prUrl);
    expect(screen.queryByTestId("fe2-lp-details-v1.0")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("fe2-lp-details-toggle-v3.4"));
    expect(screen.queryByTestId("fe2-lp-details-v3.4")).not.toBeInTheDocument();
  });
});

describe("公開中の版の切り替え", () => {
  it("shows a skeleton for the badge until the server answers, then 公開中 from the server", async () => {
    let resolve!: (s: LpPublishState) => void;
    renderScreen(fakeApi({ getPublish: () => new Promise((r) => (resolve = r)) }));
    await screen.findByTestId("fe2-lp-list");
    expect(screen.getByTestId("fe2-lp-status-loading-v3.4")).toBeInTheDocument();
    expect(screen.queryByTestId("fe2-lp-status-v3.4")).not.toBeInTheDocument();

    await act(async () => resolve(state("v3.1")));
    // 静的カタログの status:"current"(v3.4) ではなく、サーバーの versionId が公開中。
    expect(await screen.findByTestId("fe2-lp-status-v3.1")).toHaveTextContent("公開中");
    expect(screen.getByTestId("fe2-lp-status-v3.4")).toHaveTextContent("非公開");
    expect(screen.getByTestId("fe2-lp-publish-summary")).toHaveTextContent("公開中: v3.1");
  });

  it("has no publish buttons; switching lives in the 本番公開 tab", async () => {
    renderScreen();
    await screen.findByTestId("fe2-lp-publish-summary");
    expect(screen.queryByTestId("fe2-lp-publish-v3.1")).not.toBeInTheDocument();
    expect(screen.getByTestId("fe2-lp-versions-goto-publish")).toHaveTextContent("本番公開タブで切り替え");
  });
});

describe("lpViewUrl", () => {
  const publish = state("v3.4");
  it("previews publishable versions on the public site and uses ?version=live for the live one", () => {
    expect(lpViewUrl("v3.1", "https://old", publish, "https://lp.example")).toBe("https://lp.example/?version=3.1");
    expect(lpViewUrl("v3.4", "https://old", publish, "https://lp.example")).toBe("https://lp.example/?version=live");
    expect(lpViewUrl("v1.0", "https://old", publish, "https://lp.example")).toBe("https://old");
    expect(lpViewUrl("v3.1", "https://old", undefined)).toBe("https://old");
  });
});

describe("demo transport serves /lp/publish", () => {
  it("switches the live version and rejects unknown versions with 400", async () => {
    const api = createLpApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() }));
    expect((await api.getPublish()).versionId).toBe("v3.4");
    const next = await api.setPublish({ versionId: "v3.1" });
    expect(next.versionId).toBe("v3.1");
    expect(next.updatedAt).not.toBeNull();
    expect((await api.getPublish()).versionId).toBe("v3.1");
    await expect(api.setPublish({ versionId: "v1.0" })).rejects.toMatchObject({ status: 400 });
  });
});
