// @vitest-environment jsdom
// 運営ロールをイベント単位へ移した後も、名簿の一覧にそのロールが出て、ロールで絞り込めること。
import { afterEach, describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { UserListPage } from "../src/components/UserListPage";
import { renderWithProviders, makeMe } from "./renderWithProviders";
import { createMockClient } from "../src/api/mockClient";
import type { ResourceClient } from "../src/shell/contract";

const base = { orgId: "org_devhub", githubLogin: null, avatarUrl: null, status: "active", source: "manual", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
const users = [
  { ...base, id: "u_org", displayName: "Event Organizer", email: "org@developershub.jp", roleIds: ["role_member"], scopedRoleIds: ["role_sys_organizer"] },
  { ...base, id: "u_plain", displayName: "Plain Member", email: "plain@developershub.jp", roleIds: ["role_member"] },
];
const roles = [
  { id: "role_member", orgId: "org_devhub", name: "member", isSystem: true, permissions: [], createdAt: base.createdAt, updatedAt: base.updatedAt },
  { id: "role_sys_organizer", orgId: "org_devhub", name: "organizer", isSystem: true, permissions: [], createdAt: base.createdAt, updatedAt: base.updatedAt },
];

function client(): ResourceClient {
  const inner = createMockClient({ me: makeMe(["identity:read", "identity:admin"]) });
  return {
    ...inner,
    get: async <T,>(path: string, query?: Record<string, unknown>) => {
      if (path.endsWith("/identity/users")) return { items: users, nextCursor: null } as T;
      if (path.endsWith("/identity/roles")) return { items: roles, nextCursor: null } as T;
      return inner.get<T>(path, query);
    },
  };
}

afterEach(() => window.history.replaceState(null, "", "/"));

describe("roster: roles held only per event", () => {
  it("shows them as chips marked イベント", async () => {
    renderWithProviders(<UserListPage />, { client: client() });
    await waitFor(() => expect(screen.getByTestId("fe7-role-chip-event-u_org-role_sys_organizer")).toBeInTheDocument());
    expect(screen.getByTestId("fe7-role-chip-event-u_org-role_sys_organizer")).toHaveTextContent("organizer（イベント）");
    expect(screen.queryByTestId("fe7-role-chip-event-u_plain-role_sys_organizer")).not.toBeInTheDocument();
  });

  it("the role filter finds them", async () => {
    window.history.replaceState(null, "", "/?role=role_sys_organizer");
    renderWithProviders(<UserListPage />, { client: client() });
    await waitFor(() => expect(screen.getByTestId("fe7-users-row-u_org")).toBeInTheDocument());
    expect(screen.queryByTestId("fe7-users-row-u_plain")).not.toBeInTheDocument();
  });
});
