// LP管理 → 登壇者募集 のテスト。
//   (1) demo transport が登壇者募集のワイヤ契約に応答すること（REAL api-client 経由）
//   (2) LpProposalsScreen: 件数を描画 / 公開トグルは lp:publish 必須 + 同意チェック / 楽観更新の
//       ロールバック / 入力項目は固定 4 項目 + 追加分 / 応募一覧は編集者だけ / 選考状況の切り替え
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { identity } from "@dub/types";
import { describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { createLpApi, type LpApi, type LpProposal, type LpProposalsState } from "./lpApi.tsx";
import { LpApiProvider } from "./LpProvider.tsx";
import { LpProposalsScreen } from "./LpProposalsScreen.tsx";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => null }));

const PUBLISHER = editorPermissions("lp", ["lp:publish"]);
const EDITOR = editorPermissions("lp");
const VIEWER = viewerPermissions("lp");

function demoLpApi(): LpApi {
  return createLpApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() }));
}

function baseState(over: Partial<LpProposalsState> = {}): LpProposalsState {
  return {
    site: "hokuriku-it-conf.com",
    enabled: false,
    publicUrl: "https://hokuriku-it-conf.com/proposals",
    fields: [{ id: "format", label: "発表形式", type: "select", required: true, options: ["セッション（30分）", "LT（5分）"] }],
    totals: { total: 3, accepted: 1, rejected: 1 },
    updatedAt: null,
    updatedBy: null,
    ...over,
  };
}

function proposal(over: Partial<LpProposal> = {}): LpProposal {
  return {
    id: "lpp_1",
    speakerName: "北陸 太郎",
    email: "taro@example.com",
    title: "Workers の話",
    abstract: "全版同梱\n2 行目",
    answers: [{ fieldId: "format", label: "発表形式", value: "LT（5分）" }],
    status: "submitted",
    reviewedBy: null,
    createdAt: "2026-10-13T09:00:00Z",
    updatedAt: "2026-10-13T09:00:00Z",
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
    getPublish: unused,
    setPublish: unused,
    getTickets: unused,
    setTicketsEnabled: unused,
    setTicketsCta: unused,
    saveTicketFields: unused,
    createTicketType: unused,
    updateTicketType: unused,
    listTicketOrders: unused,
    approveTicketOrder: unused,
    listTicketCoupons: unused,
    createTicketCoupon: unused,
    setTicketCouponActive: unused,
    getProposals: () => Promise.resolve(baseState()),
    setProposalsEnabled: ({ enabled }) => Promise.resolve(baseState({ enabled })),
    saveProposalFields: ({ fields }) => Promise.resolve(baseState({ fields })),
    listProposals: () => Promise.resolve({ items: [proposal()], nextCursor: null }),
    setProposalStatus: (id, { status }) => Promise.resolve(proposal({ id, status })),
    ...overrides,
  };
}

function renderScreen(api: LpApi, permissions: readonly identity.PermissionKey[] = PUBLISHER): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <FakeAuthProvider permissions={permissions}>
          <LpApiProvider value={api}>
            <LpProposalsScreen />
          </LpApiProvider>
        </FakeAuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("demo transport (proposals)", () => {
  it("serves state, toggles, fields, submissions and status like lp-analytics", async () => {
    const api = demoLpApi();
    const s = await api.getProposals();
    expect(s.enabled).toBe(false);
    expect(s.publicUrl).toMatch(/\/proposals$/);
    expect(s.fields.map((f) => f.id)).toEqual(["format", "affiliation", "bio"]);
    expect((await api.setProposalsEnabled({ enabled: true })).enabled).toBe(true);

    await expect(
      api.saveProposalFields({ fields: [{ id: "title", label: "題", type: "text", required: false, options: [] }] }),
    ).rejects.toMatchObject({ status: 400 });

    const page = await api.listProposals({ limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]!.createdAt >= page.items[1]!.createdAt).toBe(true);
    const next = await api.listProposals({ limit: 2, cursor: page.nextCursor! });
    expect(next.items[0]!.id).not.toBe(page.items[1]!.id);

    const target = page.items.find((p) => p.status === "submitted")!;
    expect((await api.setProposalStatus(target.id, { status: "accepted" })).status).toBe("accepted");
    expect((await api.getProposals()).totals.accepted).toBe(s.totals.accepted + 1);
  });
});

describe("LpProposalsScreen", () => {
  it("shows a skeleton while loading", () => {
    renderScreen(fakeApi({ getProposals: () => new Promise(() => {}) }));
    expect(screen.getByTestId("fe2-lp-proposals-loading")).toBeInTheDocument();
  });

  it("shows an error with retry", async () => {
    const getProposals = vi.fn(() => Promise.reject(new Error("boom")));
    renderScreen(fakeApi({ getProposals }));
    expect(await screen.findByTestId("fe2-lp-proposals-error")).toBeInTheDocument();
  });

  it("renders counts, the public URL and the 4 fixed fields + custom ones", async () => {
    renderScreen(fakeApi());
    expect(await screen.findByTestId("fe2-lp-proposals-total")).toHaveTextContent("3 件");
    expect(screen.getByTestId("fe2-lp-proposals-open")).toHaveTextContent("1 件");
    expect(screen.getByTestId("fe2-lp-proposals-accepted")).toHaveTextContent("1 件");
    expect(screen.getByTestId("fe2-lp-proposals-enabled-state")).toHaveTextContent("停止中");
    expect(screen.getByTestId("fe2-lp-proposals-public-url")).toHaveAttribute("href", "https://hokuriku-it-conf.com/proposals");
    const locked = screen.getAllByTestId("fe2-lp-proposal-field-locked").map((el) => el.textContent);
    expect(locked).toEqual(["発表タイトル必須・固定", "発表の概要必須・固定", "氏名必須・固定", "メールアドレス必須・固定"]);
    expect(screen.getByTestId("fe2-lp-proposal-field-format")).toBeInTheDocument();
  });

  it("publishing needs the acknowledgement check, then flips optimistically", async () => {
    const setProposalsEnabled = vi.fn(({ enabled }: { enabled: boolean }) => Promise.resolve(baseState({ enabled })));
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

  it("disables the publish toggle without lp:publish", async () => {
    renderScreen(fakeApi(), EDITOR);
    expect(await screen.findByTestId("fe2-lp-proposals-enabled-hint")).toHaveTextContent("lp:publish");
  });

  it("keeps the submissions (personal data) away from viewers", async () => {
    const listProposals = vi.fn(() => Promise.resolve({ items: [proposal()], nextCursor: null }));
    renderScreen(fakeApi({ listProposals }), VIEWER);
    expect(await screen.findByTestId("fe2-lp-proposals-total")).toBeInTheDocument();
    expect(screen.queryByTestId("fe2-lp-proposal-submissions")).not.toBeInTheDocument();
    expect(screen.getByTestId("fe2-lp-proposal-submissions-locked")).toHaveTextContent("編集権限がある人にだけ");
    expect(listProposals).not.toHaveBeenCalled();
  });

  it("lists submissions with details and changes the status optimistically", async () => {
    let release: (p: LpProposal) => void = () => {};
    const setProposalStatus = vi.fn(() => new Promise<LpProposal>((r) => (release = r)));
    renderScreen(fakeApi({ setProposalStatus }), EDITOR);
    const row = await screen.findByTestId("fe2-lp-proposal-lpp_1");
    expect(row).toHaveTextContent("Workers の話");
    expect(row).toHaveTextContent("北陸 太郎・taro@example.com");

    fireEvent.click(within(row).getByTestId("fe2-lp-proposal-lpp_1-details"));
    expect(screen.getByTestId("fe2-lp-proposal-lpp_1-answers")).toHaveTextContent("LT（5分）");

    fireEvent.change(within(row).getByTestId("fe2-lp-proposal-lpp_1-status"), { target: { value: "accepted" } });
    await waitFor(() => expect(within(row).getByTestId("fe2-lp-proposal-lpp_1-status")).toHaveValue("accepted"));
    await waitFor(() => expect(screen.getByTestId("fe2-lp-proposals-accepted")).toHaveTextContent("2 件"));
    expect(setProposalStatus).toHaveBeenCalledWith("lpp_1", { status: "accepted" });
    release(proposal({ status: "accepted" }));
  });

  it("rolls the status back when the server refuses", async () => {
    renderScreen(fakeApi({ setProposalStatus: () => Promise.reject(new Error("nope")) }), EDITOR);
    const select = await screen.findByTestId("fe2-lp-proposal-lpp_1-status");
    fireEvent.change(select, { target: { value: "rejected" } });
    await waitFor(() => expect(screen.getByTestId("fe2-lp-proposal-lpp_1-status")).toHaveValue("submitted"));
    expect(screen.getByTestId("fe2-lp-proposals-total")).toHaveTextContent("3 件");
  });

  it("shows an empty state when nothing has arrived yet", async () => {
    renderScreen(fakeApi({ listProposals: () => Promise.resolve({ items: [], nextCursor: null }) }), EDITOR);
    expect(await screen.findByTestId("fe2-lp-proposal-list-empty")).toHaveTextContent("まだ応募はありません");
  });

  it("saves the custom fields as one list", async () => {
    const saveProposalFields = vi.fn(({ fields }: { fields: LpProposalsState["fields"] }) => Promise.resolve(baseState({ fields })));
    renderScreen(fakeApi({ saveProposalFields }), EDITOR);
    fireEvent.click(await screen.findByTestId("fe2-lp-proposal-field-format-remove"));
    fireEvent.click(screen.getByTestId("fe2-lp-proposal-fields-save"));
    await waitFor(() => expect(saveProposalFields).toHaveBeenCalledWith({ fields: [] }));
  });
});
