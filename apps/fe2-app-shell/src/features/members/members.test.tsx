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
    { id: "m1", orgId: "o", name: "山田太郎", roleTitle: "会場リーダー", status: "added", teamIds: ["t1"], contact: null, note: null, sortOrder: 1, version: 1, createdAt: "t", updatedAt: "t" },
    { id: "m2", orgId: "o", name: "佐藤花子", roleTitle: null, status: "invited", teamIds: ["t2"], contact: null, note: null, sortOrder: 2, version: 1, createdAt: "t", updatedAt: "t" },
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
  it("renders the member list once loaded", async () => {
    render(wrap(<MembersPage />, makeApi()));
    expect(await screen.findByText("山田太郎")).toBeInTheDocument();
    expect(screen.getByText("佐藤花子")).toBeInTheDocument();
    // status badges
    expect(screen.getByTestId("members-status-m1")).toHaveTextContent("追加済");
    expect(screen.getByTestId("members-status-m2")).toHaveTextContent("招待中");
  });

  it("switches to the team-grouped and org-chart views", async () => {
    render(wrap(<MembersPage />, makeApi()));
    await screen.findByText("山田太郎");
    await userEvent.click(screen.getByRole("tab", { name: "チーム別" }));
    expect(await screen.findByTestId("members-teamcard-t1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "組織図" }));
    expect(await screen.findByTestId("members-orgchart")).toBeInTheDocument();
  });

  it("opens the add-member dialog and creates a member", async () => {
    const api = makeApi();
    render(wrap(<MembersPage />, api));
    await screen.findByText("山田太郎");
    await userEvent.click(screen.getByTestId("members-add-member"));
    const dialog = await screen.findByTestId("members-form-dialog");
    await userEvent.type(within(dialog).getByTestId("members-form-name"), "新規 太郎");
    await userEvent.click(within(dialog).getByTestId("members-form-submit"));
    await waitFor(() => expect(api.createMember).toHaveBeenCalledTimes(1));
    expect((api.createMember as any).mock.calls[0][0]).toMatchObject({ name: "新規 太郎" });
  });

  it("deletes a member via the confirm dialog", async () => {
    const api = makeApi();
    render(wrap(<MembersPage />, api));
    await screen.findByText("山田太郎");
    await userEvent.click(screen.getByTestId("members-delete-m1"));
    const confirm = await screen.findByTestId("members-confirm-delete");
    await userEvent.click(within(confirm).getByRole("button", { name: "削除" }));
    await waitFor(() => expect(api.deleteMember).toHaveBeenCalledWith("m1"));
  });
});
