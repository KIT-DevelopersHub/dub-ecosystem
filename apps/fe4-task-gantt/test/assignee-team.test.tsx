// #882: 担当にチームを選べる・最近選んだ担当が上に出る・マイタスクに自分のチーム宛てが出る。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, within, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders as render } from "./helpers-providers";
import type { identity, team, task } from "@dub/types";
import { TaskCreateModal } from "../src/components/TaskCreateModal";
import { MyTaskCreateModal } from "../src/components/MyTaskCreateModal";
import { TaskRouteProvider } from "../src/routes/task-route-context";
import { RECENT_ASSIGNEE_KEY_PREFIX } from "../src/components/AssigneePicker";
import { assigneeLabel, decodeAssignee, encodeAssignee, isAssignedToMe } from "../src/domain/assignee";
import { lensQueries } from "../src/domain/my-tasks";
import { MockApiClient } from "../src/api/mock-client";
import { listMyTeamIds, listTasks } from "../src/api/endpoints";

beforeEach(() => localStorage.clear());

const TEAMS: team.Team[] = [{ id: "team_ops", key: "ops", name: "運営" }];
const USERS = [
  { id: "u1", displayName: "山田" },
  { id: "u2", displayName: "佐藤" },
] as identity.UserSummary[];

function pick(prefix: string, optionValue: string) {
  fireEvent.click(screen.getByTestId(`${prefix}-assignee-trigger`));
  fireEvent.click(screen.getByTestId(`${prefix}-assignee-option-${optionValue}`));
}

describe("担当ピッカー（作成フォーム = 発行フォーム共通）", () => {
  it.each([
    ["fe4-create", "gantt"],
    ["fe4-mytask-create", "mytask"],
  ])("%s: チームを担当にして作成すると assigneeTeamId が送られ assigneeId は null", async (prefix, kind) => {
    const onCreate = vi.fn(async (_draft: unknown) => {});
    const common = { open: true, onClose: () => {}, teams: TEAMS, parentOptions: [], scopeTasks: [], onCreate };
    render(
      kind === "gantt" ? <TaskCreateModal {...common} users={USERS} /> : <MyTaskCreateModal {...common} people={USERS} />,
    );
    fireEvent.change(screen.getByTestId(`${prefix}-title`), { target: { value: "受付準備" } });
    // groups: メンバー / チーム
    fireEvent.click(screen.getByTestId(`${prefix}-assignee-trigger`));
    expect(screen.getByRole("group", { name: "チーム" })).toHaveTextContent("運営");
    fireEvent.click(screen.getByTestId(`${prefix}-assignee-option-team:team_ops`));
    expect(screen.getByTestId(`${prefix}-assignee-trigger`)).toHaveTextContent("運営");
    fireEvent.click(screen.getByTestId(`${prefix}-submit`));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ assigneeId: null, assigneeTeamId: "team_ops" });
  });

  it("最近選んだ担当が利用者ごとに先頭へ浮く", () => {
    const ui = (user: string) => (
      <TaskRouteProvider value={{ currentUserId: user, permissions: [] }}>
        <TaskCreateModal open onClose={() => {}} users={USERS} teams={TEAMS} parentOptions={[]} scopeTasks={[]} onCreate={async () => {}} />
      </TaskRouteProvider>
    );
    const { unmount } = render(ui("me"));
    pick("fe4-create", "user:u2");
    expect(JSON.parse(localStorage.getItem(`${RECENT_ASSIGNEE_KEY_PREFIX}.me`)!)).toEqual(["user:u2"]);
    unmount();

    render(ui("me"));
    fireEvent.click(screen.getByTestId("fe4-create-assignee-trigger"));
    const recent = screen.getByRole("group", { name: "最近選んだ担当" });
    expect(within(recent).getAllByRole("option").map((o) => o.textContent)).toEqual(["佐藤"]);
  });

  it("別の利用者には他人の最近の担当が出ない", () => {
    localStorage.setItem(`${RECENT_ASSIGNEE_KEY_PREFIX}.me`, JSON.stringify(["user:u2"]));
    render(
      <TaskRouteProvider value={{ currentUserId: "other", permissions: [] }}>
        <TaskCreateModal open onClose={() => {}} users={USERS} teams={TEAMS} parentOptions={[]} scopeTasks={[]} onCreate={async () => {}} />
      </TaskRouteProvider>,
    );
    fireEvent.click(screen.getByTestId("fe4-create-assignee-trigger"));
    expect(screen.queryByRole("group", { name: "最近選んだ担当" })).toBeNull();
  });
});

describe("assignee domain", () => {
  it("encodes/decodes person XOR team", () => {
    expect(encodeAssignee({ assigneeId: "u1", assigneeTeamId: null })).toBe("user:u1");
    expect(encodeAssignee({ assigneeId: null, assigneeTeamId: "t1" })).toBe("team:t1");
    expect(decodeAssignee("team:t1")).toEqual({ assigneeId: null, assigneeTeamId: "t1" });
    expect(decodeAssignee("")).toEqual({ assigneeId: null, assigneeTeamId: null });
  });

  it("labels a team assignee and detects my-team assignment", () => {
    const t = { assigneeId: null, assigneeTeamId: "team_ops" };
    expect(assigneeLabel(t, () => undefined, TEAMS)).toBe("運営（チーム）");
    expect(isAssignedToMe(t, "me", ["team_ops"])).toBe(true);
    expect(isAssignedToMe(t, "me", [])).toBe(false);
  });

  it("the 担当 lens asks for me ∪ my teams", () => {
    expect(lensQueries("me", "assigned", ["t2", "t1"])).toEqual([{ assigneeId: "me", assigneeTeamId: "t1,t2", limit: 200 }]);
    expect(lensQueries("me", "assigned")).toEqual([{ assigneeId: "me", limit: 200 }]);
  });

  it("mock API mirrors the server: OR filter + my teams", async () => {
    const mk = (id: string, over: Partial<task.Task>): task.Task => ({
      id, eventId: null, title: id, description: null, status: "todo", priority: "medium", assigneeId: null,
      dueAt: null, origin: "internal", archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", version: 1, ...over,
    });
    const client = new MockApiClient({
      currentUserId: "me",
      myTeamIds: ["team_ops"],
      tasks: [mk("a", { assigneeId: "me" }), mk("b", { assigneeTeamId: "team_ops" }), mk("c", { assigneeTeamId: "team_x" })],
    });
    expect(await listMyTeamIds(client)).toEqual(["team_ops"]);
    const res = await listTasks(client, { assigneeId: "me", assigneeTeamId: "team_ops" });
    expect(res.items.map((t) => t.id).sort()).toEqual(["a", "b"]);
  });
});
