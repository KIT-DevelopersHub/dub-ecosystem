// ユーザー判断 (PR #889 staging2 確認後): チーム欄は出さない。タスクのチーム (teamId) は担当に従い、
// 詳細の上部（ステータスバッジの横）にチームバッジで見せる。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type { common, identity, task, team } from "@dub/types";
import { ToastProvider } from "@dub/ui";
import { TaskCreateModal } from "../src/components/TaskCreateModal";
import { MyTaskCreateModal } from "../src/components/MyTaskCreateModal";
import { TaskDetailDialog } from "../src/components/TaskDetailDialog";
import { TaskRouteProvider } from "../src/routes/task-route-context";
import { ApiClientProvider } from "../src/api/client-context";
import { MockApiClient } from "../src/api/mock-client";
import { listUserTeams } from "../src/api/endpoints";
import { createUserCache } from "../src/domain/user-cache";
import { deriveTaskTeam } from "../src/domain/assignee";

beforeEach(() => localStorage.clear());

const ORDER = ["A", "B", "C"];

describe("deriveTaskTeam", () => {
  const lookup = new Map<string, string[]>([
    ["solo", ["B"]],
    ["multi", ["C", "B"]],
    ["none", []],
    ["ghost", ["deleted"]],
  ]);
  it("チーム担当 → そのチーム", () => {
    expect(deriveTaskTeam({ assigneeId: null, assigneeTeamId: "C" }, "A", lookup, ORDER)).toBe("C");
  });
  it("人の担当 → その人の所属チーム", () => {
    expect(deriveTaskTeam({ assigneeId: "solo", assigneeTeamId: null }, null, lookup, ORDER)).toBe("B");
    expect(deriveTaskTeam({ assigneeId: "solo", assigneeTeamId: null }, "A", lookup, ORDER)).toBe("B");
  });
  it("複数所属: 今のチームに居ればそのまま、居なければチーム一覧の順で最初", () => {
    expect(deriveTaskTeam({ assigneeId: "multi", assigneeTeamId: null }, "C", lookup, ORDER)).toBe("C");
    expect(deriveTaskTeam({ assigneeId: "multi", assigneeTeamId: null }, "A", lookup, ORDER)).toBe("B");
    expect(deriveTaskTeam({ assigneeId: "multi", assigneeTeamId: null }, null, lookup, ORDER)).toBe("B");
  });
  it("所属なし・所属不明・一覧に無いチームだけ → 変えない", () => {
    expect(deriveTaskTeam({ assigneeId: "none", assigneeTeamId: null }, "A", lookup, ORDER)).toBe("A");
    expect(deriveTaskTeam({ assigneeId: "unknown", assigneeTeamId: null }, null, lookup, ORDER)).toBeNull();
    expect(deriveTaskTeam({ assigneeId: "ghost", assigneeTeamId: null }, "A", lookup, ORDER)).toBe("A");
  });
  it("未割当 → 変えない", () => {
    expect(deriveTaskTeam({ assigneeId: null, assigneeTeamId: null }, "A", lookup, ORDER)).toBe("A");
  });
});

describe("listUserTeams (人 → 所属チーム)", () => {
  it("名簿 (members/overview) から identity userId ごとに引く", async () => {
    const client = new MockApiClient({ memberTeams: { u1: ["B", "A"], u2: [] } });
    const m = await listUserTeams(client, "me");
    expect(m.get("u1")).toEqual(["B", "A"]);
    expect(m.has("u2")).toBe(false);
  });
  it("名簿を読めない時は自分の所属だけ (mention-teams)", async () => {
    const client = new MockApiClient({ myTeamIds: ["C"] });
    const m = await listUserTeams(client, "me");
    expect([...m.entries()]).toEqual([["me", ["C"]]]);
  });
});

const TEAMS: team.Team[] = [
  { id: "A", key: "a", name: "チームA" },
  { id: "B", key: "b", name: "チームB" },
];
const USERS = [
  { id: "u1", displayName: "山田" },
  { id: "u2", displayName: "佐藤" },
] as identity.UserSummary[];

function renderWith(ui: ReactElement, client: MockApiClient) {
  return render(
    <ApiClientProvider client={client}>
      <TaskRouteProvider value={{ currentUserId: "me", permissions: [] }}>
        <ToastProvider>{ui}</ToastProvider>
      </TaskRouteProvider>
    </ApiClientProvider>,
  );
}

describe.each([
  ["fe4-create", "gantt"],
  ["fe4-mytask-create", "mytask"],
])("%s: チーム欄は無く、teamId は担当に従う", (prefix, kind) => {
  async function createWith(assignee: string, client: MockApiClient) {
    const onCreate = vi.fn(async (_d: { teamId: common.TeamId | null }) => {});
    const props = { open: true, onClose: () => {}, teams: TEAMS, parentOptions: [], scopeTasks: [], onCreate };
    renderWith(kind === "gantt" ? <TaskCreateModal {...props} users={USERS} /> : <MyTaskCreateModal {...props} people={USERS} />, client);
    await waitFor(() => expect(client.calls.map((c) => c.path)).toContain("/api/v1/members/overview"));
    await act(async () => {});
    expect(screen.queryByTestId(`${prefix}-team`)).toBeNull();
    fireEvent.change(screen.getByTestId(`${prefix}-title`), { target: { value: "受付" } });
    fireEvent.click(screen.getByTestId(`${prefix}-assignee-trigger`));
    fireEvent.click(screen.getByTestId(`${prefix}-assignee-option-${assignee}`));
    fireEvent.click(screen.getByTestId(`${prefix}-submit`));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    return onCreate.mock.calls[0]![0];
  }

  it("人の担当 → その人の所属チーム（複数ならチーム一覧の順で最初）", async () => {
    const client = new MockApiClient({ memberTeams: { u1: ["B", "A"] } });
    expect((await createWith("user:u1", client)).teamId).toBe("A");
  });
  it("所属の無い人 → チームなし", async () => {
    const client = new MockApiClient({ memberTeams: { u1: ["B"] } });
    expect((await createWith("user:u2", client)).teamId).toBeNull();
  });
  it("チーム担当 → そのチーム", async () => {
    const client = new MockApiClient({ memberTeams: {} });
    expect((await createWith("team:B", client)).teamId).toBe("B");
  });
});

describe("マイタスクの詳細: チームはステータスの横のバッジ", () => {
  const mk = (teamId?: string): task.Task => ({
    id: "t1", eventId: "evt_1", title: "T", description: null, status: "done", priority: "medium",
    assigneeId: null, teamId, dueAt: null, origin: "internal", archivedAt: null,
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", version: 1,
  });
  const teamNames = new Map([["A", "チームA"]]);
  it("チームがあればバッジ、無ければ出さない（チーム行は無い）", () => {
    const users = createUserCache();
    const client = new MockApiClient();
    const { unmount } = renderWith(<TaskDetailDialog task={mk("A")} users={users} teamNames={teamNames} onClose={() => {}} />, client);
    expect(screen.getByTestId("fe4-mytask-detail-team-badge")).toHaveTextContent("チームA");
    expect(screen.getByTestId("fe4-status-done")).toBeInTheDocument();
    unmount();
    renderWith(<TaskDetailDialog task={mk()} users={users} teamNames={teamNames} onClose={() => {}} />, client);
    expect(screen.queryByTestId("fe4-mytask-detail-team-badge")).toBeNull();
  });
});
