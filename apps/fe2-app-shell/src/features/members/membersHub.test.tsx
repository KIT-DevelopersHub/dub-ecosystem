// 運営メンバータブ: カード / 表 の切り替え、URL と localStorage での保持、旧 /members/roster の移し先 (#901)。
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { ToastProvider } from "@dub/ui";
import type { identity } from "@dub/types";
import { member } from "@dub/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAuthProvider, editorPermissions } from "../../auth/test-support.tsx";
import { MembersApiProvider } from "./MembersProvider.tsx";
import { MembersHubPage, MemberRosterRedirect } from "./MembersHubPage.tsx";
import type { MembersApi } from "./membersApi.tsx";
import type { MembersOverview } from "./contracts.ts";
import {
  MEMBERS_VIEW_STORAGE_KEY,
  parseMembersView,
  resolveMembersView,
} from "./membersView.ts";

const P0 = member.emptyPersonProfile();
const OVERVIEW: MembersOverview = {
  teams: [{ id: "t1", key: "venue", name: "会場", color: "#4f46e5", description: null }],
  members: [
    { ...P0, id: "m1", orgId: "o", name: "山田太郎", roleTitle: "会場リーダー", status: "added", teamIds: ["t1"], department: "情報工学科", grade: "3", identityUserId: null, contact: null, note: null, sortOrder: 1, version: 1, createdAt: "t", updatedAt: "t" },
  ],
};

function makeApi(): MembersApi {
  return {
    getOverview: () => Promise.resolve(OVERVIEW),
    getOrgOverview: () => Promise.resolve(OVERVIEW),
    listTeams: () => Promise.resolve({ teams: OVERVIEW.teams }),
    listIdentityUsers: vi.fn(() => Promise.resolve({ items: [], nextCursor: null })),
  } as unknown as MembersApi;
}

const WITH_TABLE = editorPermissions("members", ["identity:read", "members:roster_view"]);
const CARDS_ONLY = editorPermissions("members", ["identity:read"]);

function renderAt(path: string, permissions: identity.PermissionKey[] = WITH_TABLE) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <FakeAuthProvider permissions={permissions}>
          <ToastProvider>
            <MembersApiProvider value={makeApi()}>
              <Outlet />
            </MembersApiProvider>
          </ToastProvider>
        </FakeAuthProvider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/members", component: MembersHubPage }),
      createRoute({ getParentRoute: () => root, path: "/members/roster", component: MemberRosterRedirect }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

// TanStack Router のスクロール復元が jsdom 未実装の scrollTo を呼ぶので黙らせる。
beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

const searchOf = (router: ReturnType<typeof renderAt>) => new URLSearchParams(router.state.location.searchStr).get("view");

describe("membersView", () => {
  it("parses only known views", () => {
    expect(parseMembersView("table")).toBe("table");
    expect(parseMembersView("cards")).toBe("cards");
    expect(parseMembersView("grid")).toBeNull();
    expect(parseMembersView(null)).toBeNull();
  });

  it("URL > 前回の表示 > カード。表を見られない人はいつもカード", () => {
    expect(resolveMembersView(null, null, true)).toBe("cards");
    expect(resolveMembersView(null, "table", true)).toBe("table");
    expect(resolveMembersView("cards", "table", true)).toBe("cards");
    expect(resolveMembersView("table", null, false)).toBe("cards");
    expect(resolveMembersView(null, "table", false)).toBe("cards");
  });
});

describe("MembersHubPage (運営メンバータブ)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("既定はカード。表に切り替えると URL と localStorage に残る", async () => {
    const router = renderAt("/members");
    expect(await screen.findByTestId("members-page")).toBeInTheDocument();
    expect(screen.getByTestId("members-view-switch")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("members-view-table"));
    expect(await screen.findByTestId("member-roster-page")).toBeInTheDocument();
    expect(screen.queryByTestId("members-page")).not.toBeInTheDocument();
    await waitFor(() => expect(searchOf(router)).toBe("table"));
    expect(localStorage.getItem(MEMBERS_VIEW_STORAGE_KEY)).toBe("table");

    await userEvent.click(screen.getByTestId("members-view-cards"));
    expect(await screen.findByTestId("members-page")).toBeInTheDocument();
    await waitFor(() => expect(searchOf(router)).toBe("cards"));
    expect(localStorage.getItem(MEMBERS_VIEW_STORAGE_KEY)).toBe("cards");
  });

  it("?view=table で開くと表になる", async () => {
    renderAt("/members?view=table");
    expect(await screen.findByTestId("member-roster-page")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "運営メンバー" })).toBeInTheDocument();
  });

  it("URL に無ければ前回選んだ表示で開く", async () => {
    localStorage.setItem(MEMBERS_VIEW_STORAGE_KEY, "table");
    renderAt("/members");
    expect(await screen.findByTestId("member-roster-page")).toBeInTheDocument();
  });

  it("表を見られない人には切り替えを出さず、?view=table でもカード", async () => {
    renderAt("/members?view=table", CARDS_ONLY);
    expect(await screen.findByTestId("members-page")).toBeInTheDocument();
    expect(screen.queryByTestId("members-view-switch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("member-roster-page")).not.toBeInTheDocument();
  });
});

describe("旧 運営名簿タブの URL (/members/roster)", () => {
  beforeEach(() => localStorage.clear());

  it("運営メンバータブの表へ置き換えて移す", async () => {
    const router = renderAt("/members/roster");
    expect(await screen.findByTestId("member-roster-page")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/members"));
    expect(searchOf(router)).toBe("table");
    // replace なので「戻る」で旧 URL に戻って再びリダイレクトされることはない
    expect(router.history.length).toBe(1);
  });

  it("表を見られない人はカードに着く", async () => {
    renderAt("/members/roster", CARDS_ONLY);
    expect(await screen.findByTestId("members-page")).toBeInTheDocument();
  });
});
