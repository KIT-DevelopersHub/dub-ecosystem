// 目標管理: 保存 (検証・楽観ロック) と、達成率の集計 (チーム別/全体・取得失敗の扱い)。
import { describe, expect, it } from "vitest";
import { goal } from "@dub/types";
import type { GoalMetricSources } from "../src/goal-repo";
import { InMemoryGoalRepo } from "../src/goal-repo";
import { call, createApp, makeDeps } from "./harness";

const MONTH = "2026-11";
const NOW = () => "2026-11-06T00:00:00.000Z";

type Kpi = Pick<goal.Kpi, "metric" | "target"> & { name?: string; manualActual?: number };
const put = (kpis: Kpi[], expectedVersion = 0, title = "協賛を獲得する") => ({
  body: { title, expectedVersion, kpis: kpis.map((k) => ({ name: k.metric, manualActual: 0, ...k })) },
});

async function setup(sources?: Partial<GoalMetricSources>) {
  const goalRepo = new InMemoryGoalRepo();
  const app = createApp(
    makeDeps({
      now: NOW,
      goalRepo,
      goalSources: { teamTasks: async () => [], lpVisitors: async () => 0, ...sources },
    }),
  );
  const team = await call(app, "POST", "/members/teams", { body: { key: "dev", name: "開発チーム" } });
  expect(team.status).toBe(201);
  return { app, goalRepo, teamId: team.json.id as string };
}

describe("目標管理", () => {
  it("saves a goal and reports progress from each source", async () => {
    const { app, goalRepo, teamId } = await setup({
      teamTasks: async (_c, m) => (m === MONTH ? [{ teamId, dueTotal: 8, dueDone: 6 }] : []),
      lpVisitors: async () => 1500,
    });
    goalRepo.counts = { ...goalRepo.counts, hr_hired: 1 };
    const saved = await call(app, "PUT", `/members/goals/${teamId}/${MONTH}`, put([
      { metric: "tasks_done", target: 12 },
      { metric: "tasks_done_rate", target: 100 },
      { metric: "lp_visitors", target: 1000 },
      { metric: "hr_hired", target: 2 },
      { metric: "manual", target: 40, manualActual: 10 },
    ]));
    expect(saved.status).toBe(200);
    expect(saved.json.version).toBe(1);

    const list = await call(app, "GET", `/members/goals?month=${MONTH}`);
    expect(list.status).toBe(200);
    const g = list.json.goals[0] as goal.TeamGoal;
    expect(g.kpis.map((k) => [k.metric, k.actual, k.percent])).toEqual([
      ["tasks_done", 6, 50],
      ["tasks_done_rate", 75, 75],
      ["lp_visitors", 1500, 150],
      ["hr_hired", 1, 50],
      ["manual", 10, 25],
    ]);
    // 150% は 100 に頭打ちして平均する: (50 + 75 + 100 + 50 + 25) / 5。
    expect(g.percent).toBe(60);
    expect(list.json.teams).toMatchObject([{ id: teamId, name: "開発チーム" }]);
  });

  it("shows a failed source as unavailable, not as 0%, and leaves it out of the team percent", async () => {
    const { app, teamId } = await setup({
      teamTasks: async () => {
        throw new Error("task-service down");
      },
    });
    await call(app, "PUT", `/members/goals/${teamId}/${MONTH}`, put([
      { metric: "tasks_done", target: 10 },
      { metric: "manual", target: 10, manualActual: 5 },
    ]));
    const { json } = await call(app, "GET", `/members/goals?month=${MONTH}`);
    expect(json.goals[0].kpis[0]).toMatchObject({ status: "unavailable", actual: null, percent: null });
    expect(json.goals[0].percent).toBe(50);
  });

  it("treats a completion rate with no tasks due as empty", async () => {
    const { app, teamId } = await setup();
    await call(app, "PUT", `/members/goals/${teamId}/${MONTH}`, put([{ metric: "tasks_done_rate", target: 100 }]));
    const { json } = await call(app, "GET", `/members/goals?month=${MONTH}`);
    expect(json.goals[0].kpis[0]).toMatchObject({ status: "empty", percent: null });
    expect(json.goals[0].percent).toBeNull();
  });

  it("does not call a source no KPI needs", async () => {
    let calls = 0;
    const count = async () => (calls++, []);
    const { app, teamId } = await setup({ teamTasks: count });
    await call(app, "PUT", `/members/goals/${teamId}/${MONTH}`, put([{ metric: "manual", target: 1 }]));
    await call(app, "GET", `/members/goals?month=${MONTH}`);
    expect(calls).toBe(0);
  });

  it("rejects a stale version and a second create", async () => {
    const { app, teamId } = await setup();
    const path = `/members/goals/${teamId}/${MONTH}`;
    await call(app, "PUT", path, put([]));
    expect((await call(app, "PUT", path, put([]))).status).toBe(409);
    expect((await call(app, "PUT", path, put([], 1, "変更後"))).json.version).toBe(2);
    expect((await call(app, "PUT", path, put([], 1))).status).toBe(409);
  });

  it.each([
    ["an empty title", put([], 0, "  ")],
    ["a zero target", put([{ metric: "manual", target: 0 }])],
    ["a negative target", put([{ metric: "manual", target: -1 }])],
    ["an unknown metric", put([{ metric: "nope" as goal.GoalMetric, target: 1 }])],
    ["a blank KPI name", put([{ metric: "manual", target: 1, name: " " }])],
    ["too many KPIs", put(Array.from({ length: goal.KPI_MAX + 1 }, () => ({ metric: "manual" as const, target: 1 })))],
  ])("rejects %s", async (_n, req) => {
    const { app, teamId } = await setup();
    expect((await call(app, "PUT", `/members/goals/${teamId}/${MONTH}`, req)).status).toBe(400);
  });

  it("rejects a bad month and an unknown team", async () => {
    const { app, teamId } = await setup();
    expect((await call(app, "GET", "/members/goals?month=2026-13")).status).toBe(400);
    expect((await call(app, "PUT", `/members/goals/${teamId}/2026-1`, put([]))).status).toBe(400);
    expect((await call(app, "PUT", `/members/goals/team_nope/${MONTH}`, put([]))).status).toBe(404);
  });

  it("deletes a goal", async () => {
    const { app, teamId } = await setup();
    const path = `/members/goals/${teamId}/${MONTH}`;
    await call(app, "PUT", path, put([]));
    expect((await call(app, "DELETE", path)).status).toBe(204);
    expect((await call(app, "GET", `/members/goals?month=${MONTH}`)).json.goals).toEqual([]);
    expect((await call(app, "DELETE", path)).status).toBe(404);
  });

  it("defaults to the current JST month", async () => {
    const goalRepo = new InMemoryGoalRepo();
    const app = createApp(makeDeps({ now: () => "2026-11-30T15:00:00.000Z", goalRepo }));
    expect((await call(app, "GET", "/members/goals")).json.month).toBe("2026-12");
  });
});
