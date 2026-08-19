// Members feature tests: the api adapter maps onto the shell ApiClient.request, and
// MembersPage renders the three views + drives the MembersApi (add/edit/delete
// dialogs, tab switch). All run against a faked MembersApi / ApiClient — no real
// network, green without a live backend.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, RequestInput } from "../../lib/api-client.tsx";
import { createMembersApi, type MembersApi } from "./membersApi.tsx";
import { MembersApiProvider } from "./MembersProvider.tsx";
import { MembersPage } from "./MembersPage.tsx";
import type { MembersOverview } from "./contracts.ts";

function fakeApiClient(result: unknown = undefined): { api: ApiClient; calls: RequestInput[] } {
  const calls: RequestInput[] = [];
  const request = vi.fn(<TRes,>(input: RequestInput): Promise<TRes> => {
    calls.push(input);
    return Promise.resolve(result as TRes);
  });
  return { api: { request } as unknown as ApiClient, calls };
}

const OVERVIEW: MembersOverview = {
  teams: [
    { id: "t1", key: "venue", name: "会場", color: "#4f46e5", description: null },
    { id: "t2", key: "pr", name: "広報", color: null, description: null },
  ],
  members: [
    { id: "m1", orgId: "o", name: "山田太郎", roleTitle: "会場リーダー", status: "added", teamIds: ["t1"], department: "情報工学科", grade: "3年", identityUserId: null, contact: null, note: null, sortOrder: 1, version: 1, createdAt: "t", updatedAt: "t" },
    { id: "m2", orgId: "o", name: "佐藤花子", roleTitle: null, status: "invited", teamIds: ["t2"], department: null, grade: null, identityUserId: null, contact: null, note: null, sortOrder: 2, version: 1, createdAt: "t", updatedAt: "t" },
  ],
};

function makeApi(overrides: Partial<MembersApi> = {}): MembersApi {
  return {
    getOverview: () => Promise.resolve(OVERVIEW),
    listTeams: () => Promise.resolve({ teams: OVERVIEW.teams }),
    createTeam: vi.fn(),
    updateTeam: vi.fn(),
    deleteTeam: vi.fn(),
    createMember: vi.fn(() => Promise.resolve(OVERVIEW.members[0]!)),
    updateMember: vi.fn(() => Promise.resolve(OVERVIEW.members[0]!)),
    deleteMember: vi.fn(() => Promise.resolve()),
    hardDeleteMember: vi.fn(() => Promise.resolve()),
    linkIdentity: vi.fn(() => Promise.resolve(OVERVIEW.members[0]!)),
    listIdentityUsers: vi.fn(() => Promise.resolve({ items: [], nextCursor: null })),
    ...overrides,
  } as MembersApi;
}

function wrap(ui: ReactNode, api: MembersApi): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MembersApiProvider value={api}>{ui}</MembersApiProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

describe("createMembersApi", () => {
  it("getOverview GETs /api/v1/members/overview", async () => {
    const { api, calls } = fakeApiClient(OVERVIEW);
    await createMembersApi(api).getOverview();
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/members/overview" });
  });

  it("createMember POSTs /api/v1/members/people", async () => {
    const { api, calls } = fakeApiClient(OVERVIEW.members[0]);
    await createMembersApi(api).createMember({ name: "A", status: "added", teamIds: ["t1"] });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/members/people" });
  });

  it("updateMember PATCHes /api/v1/members/people/:id and deleteTeam DELETEs", async () => {
    const { api, calls } = fakeApiClient({ ok: true });
    const m = createMembersApi(api);
    await m.updateMember("m1", { version: 1, status: "invited" });
    await m.deleteTeam("t1");
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/api/v1/members/people/m1" });
    expect(calls[1]).toMatchObject({ method: "DELETE", path: "/api/v1/members/teams/t1" });
  });
});

describe("MembersPage", () => {
  it("opens on チーム別 and has no flat 一覧 tab", async () => {
    render(wrap(<MembersPage />, makeApi()));
    // default view is the team-grouped one, and it lists members under their team.
    expect(await screen.findByTestId("members-teamcard-t1")).toBeInTheDocument();
    expect(screen.getByText("山田太郎")).toBeInTheDocument();
    expect(screen.getByText("佐藤花子")).toBeInTheDocument();
    // the removed 一覧 tab and its flat table must not be present.
    expect(screen.queryByRole("tab", { name: "一覧" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("members-table")).not.toBeInTheDocument();
  });

  it("switches between the team-grouped and org-chart views", async () => {
    render(wrap(<MembersPage />, makeApi()));
    expect(await screen.findByTestId("members-teamcard-t1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "組織図" }));
    expect(await screen.findByTestId("members-orgchart")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "チーム別" }));
    expect(await screen.findByTestId("members-teamcard-t1")).toBeInTheDocument();
  });

  it("opens the add-member dialog and creates a member", async () => {
    const api = makeApi();
    render(wrap(<MembersPage />, api));
    await screen.findByText("山田太郎");
    await userEvent.click(screen.getByTestId("members-add-member"));
    const dialog = await screen.findByTestId("members-form-dialog");
    await userEvent.type(within(dialog).getByTestId("members-form-name"), "新規 太郎");
    await userEvent.type(within(dialog).getByTestId("members-form-department"), "情報工学科");
    await userEvent.type(within(dialog).getByTestId("members-form-grade"), "2年");
    await userEvent.click(within(dialog).getByTestId("members-form-submit"));
    await waitFor(() => expect(api.createMember).toHaveBeenCalledTimes(1));
    expect((api.createMember as any).mock.calls[0][0]).toMatchObject({ name: "新規 太郎", department: "情報工学科", grade: "2年" });
  });

  it("soft-deletes a member via the confirm dialog (status→deleted, not physical delete)", async () => {
    const api = makeApi();
    render(wrap(<MembersPage />, api));
    await screen.findByText("山田太郎");
    // チーム別 view: delete via the member row's アクションアイコン → 論理削除(updateMember status=deleted)。
    await userEvent.click(screen.getByRole("button", { name: "山田太郎 を削除" }));
    const confirm = await screen.findByTestId("members-confirm-delete");
    await userEvent.click(within(confirm).getByRole("button", { name: "削除" }));
    await waitFor(() => expect(api.updateMember).toHaveBeenCalledWith("m1", { status: "deleted", version: 1 }));
    expect(api.deleteMember).not.toHaveBeenCalled();
  });

  it("「メンバーを削除」ボタンで削除ダイアログを開き、選んだメンバーを論理削除する", async () => {
    const api = makeApi();
    render(wrap(<MembersPage />, api));
    await screen.findByText("山田太郎");
    await userEvent.click(screen.getByTestId("members-delete-open"));
    const dialog = await screen.findByTestId("members-delete-dialog");
    // アクティブなメンバーが一覧に出る → 「削除」で確認ダイアログ → 実行で status=deleted。
    await userEvent.click(within(dialog).getByTestId("members-delete-m2"));
    const confirm = await screen.findByTestId("members-delete-confirm");
    expect(within(confirm).getByText(/佐藤花子/)).toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole("button", { name: "削除済みにする" }));
    await waitFor(() => expect(api.updateMember).toHaveBeenCalledWith("m2", { status: "deleted", version: 1 }));
  });

  it("削除ダイアログの削除はキャンセルで実行されない", async () => {
    const api = makeApi();
    render(wrap(<MembersPage />, api));
    await screen.findByText("山田太郎");
    await userEvent.click(screen.getByTestId("members-delete-open"));
    const dialog = await screen.findByTestId("members-delete-dialog");
    await userEvent.click(within(dialog).getByTestId("members-delete-m2"));
    const confirm = await screen.findByTestId("members-delete-confirm");
    await userEvent.click(within(confirm).getByRole("button", { name: "キャンセル" }));
    expect(api.updateMember).not.toHaveBeenCalled();
  });

  it("削除済みメンバーを「在籍に戻す」で復帰(status→added)できる", async () => {
    const overview: MembersOverview = {
      teams: OVERVIEW.teams,
      members: [
        { ...OVERVIEW.members[0]!, status: "added" },
        { id: "m_del", orgId: "o", name: "削除済 太郎", roleTitle: null, status: "deleted", teamIds: [], department: null, grade: null, identityUserId: null, contact: null, note: null, sortOrder: 3, version: 2, createdAt: "t", updatedAt: "t" },
      ],
    };
    const api = makeApi({ getOverview: () => Promise.resolve(overview) });
    render(wrap(<MembersPage />, api));
    await screen.findByText("削除済 太郎");
    await userEvent.click(screen.getByTestId("members-delete-open"));
    const dialog = await screen.findByTestId("members-delete-dialog");
    await userEvent.click(within(dialog).getByTestId("members-restore-m_del"));
    await waitFor(() => expect(api.updateMember).toHaveBeenCalledWith("m_del", { status: "added", version: 2 }));
  });

  it("削除済みメンバーだけに『物理削除』が出て、強い確認→実行で完全削除する", async () => {
    const overview: MembersOverview = {
      teams: OVERVIEW.teams,
      members: [
        { ...OVERVIEW.members[0]!, status: "added" }, // m1 在籍中
        { id: "m_del", orgId: "o", name: "削除済 太郎", roleTitle: null, status: "deleted", teamIds: [], department: null, grade: null, identityUserId: null, contact: null, note: null, sortOrder: 3, version: 2, createdAt: "t", updatedAt: "t" },
      ],
    };
    const api = makeApi({ getOverview: () => Promise.resolve(overview) });
    render(wrap(<MembersPage />, api));
    await screen.findByText("削除済 太郎");
    await userEvent.click(screen.getByTestId("members-delete-open"));
    const dialog = await screen.findByTestId("members-delete-dialog");
    // 在籍中(m1)には物理削除ボタンは出ない（削除済みだけ）。
    expect(within(dialog).queryByTestId("members-purge-m1")).not.toBeInTheDocument();
    // 削除済み m_del には物理削除がある → 強い確認 → 実行。
    await userEvent.click(within(dialog).getByTestId("members-purge-m_del"));
    const confirm = await screen.findByTestId("members-purge-confirm");
    expect(within(confirm).getByRole("heading", { name: /完全に削除しますか/ })).toBeInTheDocument();
    expect(within(confirm).getByText(/削除済 太郎/)).toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole("button", { name: "完全に削除する" }));
    await waitFor(() => expect(api.hardDeleteMember).toHaveBeenCalledWith("m_del"));
  });

  it("物理削除はキャンセルで実行されない", async () => {
    const overview: MembersOverview = {
      teams: OVERVIEW.teams,
      members: [{ id: "m_del", orgId: "o", name: "削除済 花子", roleTitle: null, status: "deleted", teamIds: [], department: null, grade: null, identityUserId: null, contact: null, note: null, sortOrder: 1, version: 2, createdAt: "t", updatedAt: "t" }],
    };
    const api = makeApi({ getOverview: () => Promise.resolve(overview) });
    render(wrap(<MembersPage />, api));
    await screen.findByText("削除済 花子");
    await userEvent.click(screen.getByTestId("members-delete-open"));
    const dialog = await screen.findByTestId("members-delete-dialog");
    await userEvent.click(within(dialog).getByTestId("members-purge-m_del"));
    const confirm = await screen.findByTestId("members-purge-confirm");
    await userEvent.click(within(confirm).getByRole("button", { name: "キャンセル" }));
    expect(api.hardDeleteMember).not.toHaveBeenCalled();
  });

  // Regression: the 組織図 must reflect the SAME population as the 一覧 (辞退除く). Nobody
  // should silently vanish — not team-less members, not members whose teamIds point at a
  // team that no longer exists (orphan ref). Declined stays hidden by design.
  it("組織図 shows every non-declined member (team-less + orphan-team refs included)", async () => {
    const overview: MembersOverview = {
      teams: [{ id: "t1", key: "venue", name: "会場", color: "#16a34a", description: null }],
      members: [
        { id: "p_team", orgId: "o", name: "所属アリ子", roleTitle: "会場リーダー", status: "added", teamIds: ["t1"], department: null, grade: null, identityUserId: null, contact: null, note: null, sortOrder: 1, version: 1, createdAt: "t", updatedAt: "t" },
        { id: "p_none", orgId: "o", name: "未所属無太郎", roleTitle: null, status: "added", teamIds: [], department: null, grade: null, identityUserId: null, contact: null, note: null, sortOrder: 2, version: 1, createdAt: "t", updatedAt: "t" },
        { id: "p_orphan", orgId: "o", name: "幽霊参照子", roleTitle: null, status: "added", teamIds: ["deleted_team_999"], department: null, grade: null, identityUserId: null, contact: null, note: null, sortOrder: 3, version: 1, createdAt: "t", updatedAt: "t" },
        { id: "p_gone", orgId: "o", name: "辞退済子", roleTitle: null, status: "declined", teamIds: ["t1"], department: null, grade: null, identityUserId: null, contact: null, note: null, sortOrder: 4, version: 1, createdAt: "t", updatedAt: "t" },
        { id: "p_deleted", orgId: "o", name: "削除済子", roleTitle: null, status: "deleted", teamIds: ["t1"], department: null, grade: null, identityUserId: null, contact: null, note: null, sortOrder: 5, version: 1, createdAt: "t", updatedAt: "t" },
      ],
    };
    render(wrap(<MembersPage />, makeApi({ getOverview: () => Promise.resolve(overview) })));
    await screen.findByText("所属アリ子");
    await userEvent.click(screen.getByRole("tab", { name: "組織図" }));
    await screen.findByTestId("members-orgchart");
    // 3 non-declined/non-deleted members are ALL rendered; declined + deleted are hidden.
    expect(screen.getByTestId("members-orgchip-p_team")).toBeInTheDocument();
    expect(screen.getByTestId("members-orgchip-p_none")).toBeInTheDocument();
    expect(screen.getByTestId("members-orgchip-p_orphan")).toBeInTheDocument();
    expect(screen.queryByTestId("members-orgchip-p_gone")).not.toBeInTheDocument();
    expect(screen.queryByTestId("members-orgchip-p_deleted")).not.toBeInTheDocument();
    // team-less + orphan-ref members land in the muted 未所属 note (NOT a pseudo-team
    // column) at the foot of the chart.
    const org = screen.getByTestId("members-orgchart");
    const note = within(org).getByTestId("members-orgchart-unassigned");
    expect(note).toBeInTheDocument();
    expect(within(note).getByText("未所属（チーム未割り当て）")).toBeInTheDocument();
    expect(within(note).getByTestId("members-orgchip-p_none")).toBeInTheDocument();
    expect(within(note).getByTestId("members-orgchip-p_orphan")).toBeInTheDocument();
  });
});
