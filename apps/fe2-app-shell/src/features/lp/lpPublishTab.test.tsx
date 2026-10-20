// LP管理 → 本番公開 tests.
// 本番の LP を変えるスイッチ（公開する版・チケット販売・参加登録ボタン差し替え・登壇者募集）はこのタブに集約。
// どれも確認ダイアログ → 楽観的に反映 → 失敗でロールバック。lp:publish が無い / 403 なら読み取り専用。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { identity } from "@dub/types";
import { describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { ApiError, createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { LpPublishScreen } from "./LpPublishScreen.tsx";
import { createLpApi, type LpApi, type LpProposalsState, type LpPublishState, type LpTicketsState } from "./lpApi.tsx";
import { LpApiProvider } from "./LpProvider.tsx";
import { lpLiveUrl, PUBLISH_SUCCESS_MARKER } from "./lpPublish.ts";
import { lpRoutes } from "./module.tsx";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => null }));

const PUBLISHABLE = ["v3.5", "v3.4", "v3.3", "v3.2", "v3.1", "v3.0", "v2.0"];
const PUBLISHER = editorPermissions("lp", ["lp:publish"]);
const EDITOR = editorPermissions("lp");

function publishState(versionId: string): LpPublishState {
  return { site: "hokuriku-it-conf.com", versionId, versions: PUBLISHABLE, updatedAt: null, updatedBy: null };
}

function tickets(over: Partial<LpTicketsState> = {}): LpTicketsState {
  return {
    site: "hokuriku-it-conf.com",
    enabled: false,
    ctaEnabled: false,
    paymentReady: true,
    publicUrl: "https://hokuriku-it-conf.com/tickets",
    fields: [],
    types: [],
    totals: { sold: 0, revenueJpy: 0 },
    updatedAt: null,
    updatedBy: null,
    ...over,
  };
}

function proposals(over: Partial<LpProposalsState> = {}): LpProposalsState {
  return {
    site: "hokuriku-it-conf.com",
    enabled: false,
    publicUrl: "https://hokuriku-it-conf.com/proposals",
    fields: [],
    totals: { total: 0, accepted: 0, rejected: 0 },
    updatedAt: null,
    updatedBy: null,
    ...over,
  };
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
    getPublish: () => Promise.resolve(publishState("v3.4")),
    setPublish: ({ versionId }) => Promise.resolve(publishState(versionId)),
    getTickets: () => Promise.resolve(tickets()),
    setTicketsEnabled: ({ enabled }) => Promise.resolve(tickets({ enabled })),
    setTicketsCta: ({ enabled }) => Promise.resolve(tickets({ ctaEnabled: enabled })),
    saveTicketFields: unused,
    createTicketType: unused,
    updateTicketType: unused,
    listTicketOrders: unused,
    getProposals: () => Promise.resolve(proposals()),
    setProposalsEnabled: ({ enabled }) => Promise.resolve(proposals({ enabled })),
    saveProposalFields: unused,
    listProposals: unused,
    setProposalStatus: unused,
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
            <LpPublishScreen />
          </LpApiProvider>
        </FakeAuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function forbidden(): ApiError {
  return new ApiError(403, { error: { code: "FORBIDDEN", message: "権限がありません", retryable: false } });
}

describe("本番公開 tab", () => {
  it("is routed at /lp/publish and sits between バージョン and プレビュー", () => {
    const paths = lpRoutes.map((r) => r.path);
    expect(paths.slice(0, 3)).toEqual(["/lp", "/lp/publish", "/lp/preview"]);
    renderScreen(fakeApi({ getPublish: () => new Promise(() => {}) }));
    const labels = within(screen.getByTestId("fe2-lp-tabs")).getAllByRole("tab").map((t) => t.textContent);
    expect(labels).toEqual(["バージョン", "本番公開", "プレビュー", "流入URL", "ログ管理", "チケット", "登壇者募集"]);
  });

  it("shows skeletons per section while loading", () => {
    const pending = () => new Promise<never>(() => {});
    renderScreen(fakeApi({ getPublish: pending, getTickets: pending, getProposals: pending }));
    expect(screen.getByTestId("fe2-lp-publish-version-loading")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-lp-publish-tickets-loading")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-lp-publish-proposals-loading")).toBeInTheDocument();
  });

  it("shows a retryable error per section", async () => {
    renderScreen(fakeApi({ getTickets: () => Promise.reject(new Error("boom")) }));
    expect(await screen.findByTestId("fe2-lp-publish-tickets-error")).toBeInTheDocument();
    expect(await screen.findByTestId("fe2-lp-publish-current-version")).toHaveTextContent("v3.4");
  });

  it("embeds the live LP without preview params (?version=live clears preview cookies)", async () => {
    renderScreen();
    const frame = screen.getByTestId("fe2-lp-publish-live-frame");
    expect(frame).toHaveAttribute("src", lpLiveUrl());
    expect(lpLiveUrl("https://lp.example")).toBe("https://lp.example/?version=live");
    expect(screen.getByTestId("fe2-lp-publish-live-note")).toHaveTextContent("30");
    fireEvent.click(screen.getByTestId("fe2-lp-publish-live-open"));
    expect(screen.getByTestId("fe2-lp-viewer-frame")).toHaveAttribute("src", lpLiveUrl());
  });
});

describe("本番公開 → 公開する版", () => {
  it("offers only bundled versions and disables the button until another version is picked", async () => {
    renderScreen();
    const select = await screen.findByTestId("fe2-lp-publish-version");
    const values = Array.from((select as HTMLSelectElement).options).map((o) => o.value);
    expect(values).not.toContain("v1.0");
    expect(values).toContain("v3.1");
    expect(screen.getByTestId("fe2-lp-publish-version-apply")).toBeDisabled();
    fireEvent.change(select, { target: { value: "v3.1" } });
    expect(screen.getByTestId("fe2-lp-publish-version-apply")).toBeEnabled();
  });

  it("confirms, switches optimistically and announces success", async () => {
    let finish!: (s: LpPublishState) => void;
    const setPublish = vi.fn((_input: { versionId: string }) => new Promise<LpPublishState>((r) => (finish = r)));
    renderScreen(fakeApi({ setPublish }));
    fireEvent.change(await screen.findByTestId("fe2-lp-publish-version"), { target: { value: "v3.1" } });
    fireEvent.click(screen.getByTestId("fe2-lp-publish-version-apply"));

    const dialog = screen.getByTestId("fe2-lp-publish-dialog");
    const diff = within(dialog).getByTestId("fe2-lp-publish-diff");
    expect(diff).toHaveTextContent("v3.4 SEO対策版");
    expect(diff).toHaveTextContent("v3.1 ヒーロー立体強化版");
    fireEvent.click(screen.getByTestId("fe2-lp-publish-confirm"));

    await waitFor(() => expect(screen.getByTestId("fe2-lp-publish-current-version")).toHaveTextContent("v3.1"));
    expect(setPublish).toHaveBeenCalledWith({ versionId: "v3.1" });
    await act(async () => finish(publishState("v3.1")));
    expect(await screen.findByText("公開中の版を v3.1 ヒーロー立体強化版 に切り替えました")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-lp-publish-live")).toHaveTextContent(PUBLISH_SUCCESS_MARKER);
  });

  it("rolls back on failure", async () => {
    const setPublish = () =>
      Promise.reject(new ApiError(500, { error: { code: "INTERNAL", message: "boom", retryable: true } }));
    renderScreen(fakeApi({ setPublish }));
    fireEvent.change(await screen.findByTestId("fe2-lp-publish-version"), { target: { value: "v3.1" } });
    fireEvent.click(screen.getByTestId("fe2-lp-publish-version-apply"));
    fireEvent.click(screen.getByTestId("fe2-lp-publish-confirm"));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-publish-current-version")).toHaveTextContent("v3.4"));
    expect(screen.getByTestId("fe2-lp-publish-live")).toHaveTextContent("");
  });

  it("cancel closes the dialog without calling the api", async () => {
    const setPublish = vi.fn();
    renderScreen(fakeApi({ setPublish }));
    fireEvent.change(await screen.findByTestId("fe2-lp-publish-version"), { target: { value: "v3.1" } });
    fireEvent.click(screen.getByTestId("fe2-lp-publish-version-apply"));
    fireEvent.click(screen.getByTestId("fe2-lp-publish-cancel"));
    await waitFor(() => expect(screen.queryByTestId("fe2-lp-publish-dialog")).not.toBeInTheDocument());
    expect(setPublish).not.toHaveBeenCalled();
  });
});

describe("本番公開 → チケット販売", () => {
  it("publishing warns it goes public to everyone and needs the acknowledgement", async () => {
    const setEnabled = vi.fn(({ enabled }: { enabled: boolean }) => Promise.resolve(tickets({ enabled })));
    renderScreen(fakeApi({ setTicketsEnabled: setEnabled }));
    fireEvent.click(await screen.findByTestId("fe2-lp-tickets-enabled"));
    const dialog = await screen.findByTestId("fe2-lp-tickets-enabled-dialog");
    expect(within(dialog).getByTestId("fe2-lp-tickets-enabled-warning")).toHaveTextContent(
      "本当に全ユーザーに公開されますがよろしいですか？",
    );
    const confirm = within(dialog).getByTestId("fe2-lp-tickets-enabled-confirm");
    expect(confirm).toBeDisabled();
    fireEvent.click(within(dialog).getByTestId("fe2-lp-tickets-enabled-ack"));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByTestId("fe2-lp-tickets-enabled-state")).toHaveTextContent("公開中"));
    expect(setEnabled).toHaveBeenCalledWith({ enabled: true });
  });

  it("flips optimistically and rolls back when the server refuses", async () => {
    let reject: (e: Error) => void = () => undefined;
    renderScreen(
      fakeApi({
        setTicketsEnabled: () =>
          new Promise((_res, rej) => {
            reject = rej;
          }),
      }),
    );
    fireEvent.click(await screen.findByTestId("fe2-lp-tickets-enabled"));
    fireEvent.click(await screen.findByTestId("fe2-lp-tickets-enabled-ack"));
    fireEvent.click(screen.getByTestId("fe2-lp-tickets-enabled-confirm"));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-tickets-enabled")).toBeChecked());
    reject(new Error("boom"));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-tickets-enabled")).not.toBeChecked());
    expect(await screen.findByText("販売状態を切り替えられませんでした")).toBeInTheDocument();
  });

  it("stopping sales needs no acknowledgement", async () => {
    const setEnabled = vi.fn(({ enabled }: { enabled: boolean }) => Promise.resolve(tickets({ enabled })));
    renderScreen(fakeApi({ getTickets: () => Promise.resolve(tickets({ enabled: true })), setTicketsEnabled: setEnabled }));
    fireEvent.click(await screen.findByTestId("fe2-lp-tickets-enabled"));
    const dialog = await screen.findByTestId("fe2-lp-tickets-enabled-dialog");
    expect(within(dialog).queryByTestId("fe2-lp-tickets-enabled-ack")).toBeNull();
    fireEvent.click(within(dialog).getByTestId("fe2-lp-tickets-enabled-confirm"));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith({ enabled: false }));
  });

  it("saves the CTA swap without a dialog while sales are off (it only takes effect once on sale)", async () => {
    const cta = vi.fn(({ enabled }: { enabled: boolean }) => Promise.resolve(tickets({ ctaEnabled: enabled })));
    renderScreen(fakeApi({ setTicketsCta: cta }));
    expect(await screen.findByTestId("fe2-lp-tickets-cta-hint")).toHaveTextContent("販売を公開すると有効になります");
    fireEvent.click(screen.getByTestId("fe2-lp-tickets-cta"));
    expect(screen.queryByTestId("fe2-lp-tickets-cta-dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(cta).toHaveBeenCalledWith({ enabled: true }));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-tickets-cta-state")).toHaveTextContent("販売の公開待ち"));
  });

  it("confirms the CTA swap while on sale and rolls back on failure", async () => {
    renderScreen(
      fakeApi({
        getTickets: () => Promise.resolve(tickets({ enabled: true })),
        setTicketsCta: () => Promise.reject(new Error("boom")),
      }),
    );
    fireEvent.click(await screen.findByTestId("fe2-lp-tickets-cta"));
    const dialog = await screen.findByTestId("fe2-lp-tickets-cta-dialog");
    expect(dialog).toHaveTextContent("参加チケットを購入");
    fireEvent.click(within(dialog).getByTestId("fe2-lp-tickets-cta-confirm"));
    expect(await screen.findByText("参加登録ボタンの設定を切り替えられませんでした")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("fe2-lp-tickets-cta")).not.toBeChecked());
  });
});

describe("本番公開 → 登壇者募集", () => {
  it("publishing needs the acknowledgement check, then flips optimistically", async () => {
    const setProposalsEnabled = vi.fn(({ enabled }: { enabled: boolean }) => Promise.resolve(proposals({ enabled })));
    renderScreen(fakeApi({ setProposalsEnabled }));
    fireEvent.click(await screen.findByTestId("fe2-lp-proposals-enabled"));
    const dialog = await screen.findByTestId("fe2-lp-proposals-enabled-dialog");
    expect(within(dialog).getByTestId("fe2-lp-proposals-enabled-warning")).toHaveTextContent("全ユーザーに公開");
    expect(screen.getByTestId("fe2-lp-proposals-enabled-confirm")).toBeDisabled();
    fireEvent.click(screen.getByTestId("fe2-lp-proposals-enabled-ack"));
    fireEvent.click(screen.getByTestId("fe2-lp-proposals-enabled-confirm"));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-proposals-enabled-state")).toHaveTextContent("募集中"));
    expect(setProposalsEnabled).toHaveBeenCalledWith({ enabled: true });
  });

  it("rolls the toggle back when the server refuses", async () => {
    renderScreen(fakeApi({ setProposalsEnabled: () => Promise.reject(new Error("nope")) }));
    fireEvent.click(await screen.findByTestId("fe2-lp-proposals-enabled"));
    fireEvent.click(await screen.findByTestId("fe2-lp-proposals-enabled-ack"));
    fireEvent.click(screen.getByTestId("fe2-lp-proposals-enabled-confirm"));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-proposals-enabled-state")).toHaveTextContent("停止中"));
  });
});

describe("本番公開 → 読み取り専用", () => {
  it.each([
    ["editor without lp:publish", EDITOR],
    ["viewer with lp:publish", viewerPermissions("lp", ["lp:publish"])],
  ])("%s sees every switch disabled with the read-only notice", async (_name, perms) => {
    renderScreen(fakeApi(), perms);
    expect(await screen.findByTestId("fe2-lp-tickets-enabled")).toBeDisabled();
    expect(screen.getByTestId("fe2-lp-tickets-cta")).toBeDisabled();
    expect(await screen.findByTestId("fe2-lp-proposals-enabled")).toBeDisabled();
    expect(await screen.findByTestId("fe2-lp-publish-version")).toBeDisabled();
    expect(screen.getByTestId("fe2-lp-publish-readonly")).toHaveTextContent("lp:publish");
  });

  it("turns read-only after the server answers 403", async () => {
    renderScreen(fakeApi({ setProposalsEnabled: () => Promise.reject(forbidden()) }));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-proposals-enabled")).toBeEnabled());
    expect(screen.queryByTestId("fe2-lp-publish-readonly")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("fe2-lp-proposals-enabled"));
    fireEvent.click(await screen.findByTestId("fe2-lp-proposals-enabled-ack"));
    fireEvent.click(screen.getByTestId("fe2-lp-proposals-enabled-confirm"));
    expect(await screen.findByTestId("fe2-lp-publish-readonly")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("fe2-lp-proposals-enabled")).toBeDisabled());
    expect(screen.getByTestId("fe2-lp-tickets-enabled")).toBeDisabled();
  });
});

describe("本番公開 on the demo transport", () => {
  it("renders every section from the demo seed (not a blank screen)", async () => {
    renderScreen(createLpApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() })));
    expect(await screen.findByTestId("fe2-lp-publish-current-version")).toHaveTextContent("v3.4");
    expect(await screen.findByTestId("fe2-lp-tickets-enabled-state")).toBeInTheDocument();
    expect(await screen.findByTestId("fe2-lp-proposals-enabled-state")).toBeInTheDocument();
  });
});
