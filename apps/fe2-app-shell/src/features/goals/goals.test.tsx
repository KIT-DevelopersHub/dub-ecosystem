// 目標管理のテスト。demo transport が /members/goals の契約に応答すること (REAL api-client 経由) と、
// 一覧の表示・権限の出し分け・保存の楽観更新/ロールバック。
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import { goal, type identity } from "@dub/types";
import { describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { ApiError, createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { createGoalsApi, type GoalsApi } from "./goalsApi.tsx";
import { GoalsApiProvider } from "./GoalsProvider.tsx";
import { GoalsScreen } from "./GoalsScreen.tsx";
import { optimisticGoal } from "./goalsHooks.ts";

const EDITOR = editorPermissions("goals", ["goals:read"]);
const VIEWER = viewerPermissions("goals", ["goals:read"]);
const MONTH = goal.currentMonth();

const teams: goal.GoalTeam[] = [
  { id: "team_a", name: "開発チーム", color: "#0d9488" },
  { id: "team_b", name: "広報チーム", color: null },
];

const kpi = (over: Partial<goal.KpiProgress> = {}): goal.KpiProgress => ({
  name: "タスク完了数", metric: "tasks_done", target: 10, manualActual: 0, status: "ok", actual: 5, percent: 50, ...over,
});

const teamGoal = (over: Partial<goal.TeamGoal> = {}): goal.TeamGoal => ({
  teamId: "team_a", month: MONTH, title: "機能を期日どおりに出す", kpis: [kpi()], percent: 50, version: 1,
  updatedBy: "usr_1" as goal.TeamGoal["updatedBy"], updatedByName: null, updatedAt: "2026-11-01T00:00:00Z", ...over,
});

function fakeApi(goals: goal.TeamGoal[], over: Partial<GoalsApi> = {}): GoalsApi {
  return {
    list: vi.fn(async (month) => ({ month, teams, goals })),
    put: vi.fn(async (teamId, month, body) => teamGoal({ teamId, month, title: body.title, version: body.expectedVersion + 1 })),
    remove: vi.fn(async () => undefined),
    ...over,
  };
}

function mount(api: GoalsApi, permissions: readonly identity.PermissionKey[] = EDITOR) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <FakeAuthProvider permissions={[...permissions]}>
          <GoalsApiProvider value={api}><GoalsScreen /></GoalsApiProvider>
        </FakeAuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("目標管理 demo transport", () => {
  it("answers list, save (with version check) and delete", async () => {
    const api = createGoalsApi(createApiClient({ baseUrl: "http://demo", fetchImpl: createDemoFetch() }));
    const list = await api.list(MONTH);
    const dev = list.goals.find((g) => g.teamId === "team_dev")!;
    expect(dev.percent).toBeGreaterThan(0);
    expect(list.teams.some((t) => t.id === "team_dev")).toBe(true);

    const saved = await api.put("team_dev", MONTH, { title: "更新", expectedVersion: dev.version, kpis: [{ name: "手入力", metric: "manual", target: 4, manualActual: 1 }] });
    expect(saved).toMatchObject({ version: dev.version + 1, percent: 25 });
    await expect(api.put("team_dev", MONTH, { title: "古い", expectedVersion: dev.version, kpis: [] })).rejects.toMatchObject({ status: 409 });

    await api.remove("team_dev", MONTH);
    expect((await api.list(MONTH)).goals.some((g) => g.teamId === "team_dev")).toBe(false);
  });
});

describe("GoalsScreen", () => {
  it("shows each team's percent and an unset state for the others", async () => {
    mount(fakeApi([teamGoal({ kpis: [kpi(), kpi({ name: "LP", metric: "lp_visitors", status: "unavailable", actual: null, percent: null })] })]));
    expect(await screen.findByTestId("fe2-goals-percent-team_a")).toHaveTextContent("50%");
    const card = screen.getByTestId("fe2-goals-team-team_a");
    expect(within(card).getByText("5件 / 10件")).toBeInTheDocument();
    expect(within(card).getByText("タスクから自動集計")).toBeInTheDocument();
    expect(within(card).getByText("LP管理から自動集計（全体）")).toBeInTheDocument();
    expect(within(card).getByText("集計できませんでした")).toBeInTheDocument();
    expect(within(screen.getByTestId("fe2-goals-team-team_b")).getByText("この月の目標は未設定です")).toBeInTheDocument();
  });

  it("marks an achieved goal with text, not colour alone", async () => {
    mount(fakeApi([teamGoal({ percent: 100, kpis: [kpi({ actual: 12, percent: 120 })] })]));
    expect(await screen.findByText("達成")).toBeInTheDocument();
    expect(screen.getByText("120%")).toBeInTheDocument();
  });

  it("hides editing from a viewer", async () => {
    mount(fakeApi([teamGoal()]), VIEWER);
    await screen.findByTestId("fe2-goals-percent-team_a");
    expect(screen.queryByTestId("fe2-goals-edit-team_a")).toBeNull();
    expect(screen.queryByTestId("fe2-goals-set-team_b")).toBeNull();
  });

  it("loads the chosen month", async () => {
    const api = fakeApi([]);
    mount(api);
    fireEvent.click(await screen.findByTestId("fe2-goals-prev"));
    await waitFor(() => expect(api.list).toHaveBeenCalledWith(goal.shiftMonth(MONTH, -1)));
  });

  it("creates a goal and shows it right away", async () => {
    const api = fakeApi([]);
    mount(api);
    fireEvent.click(await screen.findByTestId("fe2-goals-set-team_b"));
    expect(screen.getByTestId("fe2-goals-save")).toBeDisabled();
    fireEvent.change(screen.getByTestId("fe2-goals-title"), { target: { value: "認知を広げる" } });
    fireEvent.change(screen.getByTestId("fe2-goals-kpi-target-0"), { target: { value: "20" } });
    fireEvent.click(screen.getByTestId("fe2-goals-save"));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("team_b", MONTH, {
      title: "認知を広げる", expectedVersion: 0, kpis: [{ name: "タスク完了数", metric: "tasks_done", target: 20, manualActual: 0 }],
    }));
    expect(await within(screen.getByTestId("fe2-goals-team-team_b")).findByText("認知を広げる")).toBeInTheDocument();
  });

  it("rolls back and explains when someone else saved first", async () => {
    const put = vi.fn(async () => {
      throw new ApiError(409, { error: { code: "GOAL_VERSION_CONFLICT", message: "conflict" } } as never);
    });
    mount(fakeApi([teamGoal()], { put }));
    fireEvent.click(await screen.findByTestId("fe2-goals-edit-team_a"));
    fireEvent.change(screen.getByTestId("fe2-goals-title"), { target: { value: "別の目標" } });
    fireEvent.click(screen.getByTestId("fe2-goals-save"));
    expect(await screen.findByText("他の人が先に更新しました。最新の内容を確認してください")).toBeInTheDocument();
    expect(within(screen.getByTestId("fe2-goals-team-team_a")).getByText("機能を期日どおりに出す")).toBeInTheDocument();
  });
});

describe("optimisticGoal", () => {
  it("keeps known actuals and leaves a newly chosen metric unknown", () => {
    const next = optimisticGoal("team_a", MONTH, {
      title: "t", expectedVersion: 1,
      kpis: [
        { name: "a", metric: "tasks_done", target: 20, manualActual: 0 },
        { name: "b", metric: "manual", target: 4, manualActual: 2 },
        { name: "c", metric: "hr_hired", target: 2, manualActual: 0 },
      ],
    }, teamGoal());
    expect(next.kpis.map((k) => k.percent)).toEqual([25, 50, null]);
    expect(next.percent).toBe(38);
  });
});
