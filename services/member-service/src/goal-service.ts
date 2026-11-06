// 目標管理のビジネスロジック。HTTP 非依存。指標の定義と達成率の計算は @dub/types goal が SoT。
//
// 実績は表示のたびに数える。必要な数字だけ取りに行き、取れなかった指標は 0 ではなく
// unavailable として返す (止まっている連携を「進捗 0%」に見せない)。
import type { RequestContext } from "@dub/http";
import { DubError, errors } from "@dub/errors";
import { goal } from "@dub/types";
import type { GoalMetricSources, GoalRepo, GoalRow, MemberMonthCounts, TeamTaskCounts } from "./goal-repo";
import type { ReqCtx } from "./service";
import type { AppDeps } from "./types";

const errGoalNotFound = (): DubError => new DubError("GOAL_NOT_FOUND", "Goal not found", { status: 404 });
const errTeamNotFound = (id: string): DubError => new DubError("GOAL_TEAM_NOT_FOUND", `Team not found: ${id}`, { status: 404 });
const errVersionConflict = (): DubError => new DubError("GOAL_VERSION_CONFLICT", "Goal was changed by someone else", { status: 409 });

const isValue = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= goal.KPI_VALUE_MAX;

function parseKpis(raw: unknown): goal.Kpi[] {
  if (!Array.isArray(raw) || raw.length > goal.KPI_MAX) throw errors.validationFailed([{ field: "kpis", reason: "invalid" }]);
  return raw.map((k: Partial<goal.Kpi> | null, i): goal.Kpi => {
    const name = typeof k?.name === "string" ? k.name.trim() : "";
    if (name.length === 0 || name.length > goal.KPI_NAME_MAX) throw errors.validationFailed([{ field: `kpis.${i}.name`, reason: "invalid" }]);
    if (!goal.isGoalMetric(k?.metric)) throw errors.validationFailed([{ field: `kpis.${i}.metric`, reason: "invalid" }]);
    if (!isValue(k?.target) || k.target === 0) throw errors.validationFailed([{ field: `kpis.${i}.target`, reason: "invalid" }]);
    const manualActual = k.metric === "manual" ? (k.manualActual ?? 0) : 0;
    if (!isValue(manualActual)) throw errors.validationFailed([{ field: `kpis.${i}.manualActual`, reason: "invalid" }]);
    return { name, metric: k.metric, target: k.target, manualActual };
  });
}

/** Promise を「失敗 = null」にする。 */
const orNull = <T>(p: Promise<T>): Promise<T | null> =>
  p.catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({ level: "warn", service: "member-service", msg: "goal metric source failed", error: err instanceof Error ? err.message : String(err) }));
    return null;
  });

interface Actuals {
  member: MemberMonthCounts | null;
  tasks: Map<string, TeamTaskCounts> | null;
  lpVisitors: number | null;
}

const LOCAL_METRICS: readonly goal.GoalMetric[] = ["hr_applicants", "hr_interviews", "hr_hired", "sponsor_cards", "participations"];

export function progressOf(kpi: goal.Kpi, teamId: string, a: Actuals): goal.KpiProgress {
  const done = (status: goal.KpiStatus, actual: number | null): goal.KpiProgress => ({
    ...kpi,
    status,
    actual,
    percent: goal.kpiPercent(actual, kpi.target),
  });
  const { metric } = kpi;
  if (metric === "manual") return done("ok", kpi.manualActual);
  if (metric === "lp_visitors") return a.lpVisitors === null ? done("unavailable", null) : done("ok", a.lpVisitors);
  if (metric === "tasks_done" || metric === "tasks_done_rate") {
    if (a.tasks === null) return done("unavailable", null);
    const t = a.tasks.get(teamId) ?? { dueTotal: 0, dueDone: 0 };
    if (metric === "tasks_done") return done("ok", t.dueDone);
    return t.dueTotal === 0 ? done("empty", null) : done("ok", Math.round((t.dueDone / t.dueTotal) * 100));
  }
  return a.member === null ? done("unavailable", null) : done("ok", a.member[metric]);
}

export interface GoalDeps extends Pick<AppDeps, "orgId" | "now" | "repo"> {
  goalRepo: GoalRepo;
  goalSources: GoalMetricSources;
}

export class GoalService {
  constructor(private readonly deps: GoalDeps) {}

  private async collect(ctx: RequestContext, month: string, rows: readonly GoalRow[]): Promise<Actuals> {
    const { goalRepo, goalSources, orgId } = this.deps;
    const used = new Set(rows.flatMap((r) => r.kpis.map((k) => k.metric)));
    const [member, tasks, lpVisitors] = await Promise.all([
      LOCAL_METRICS.some((m) => used.has(m)) ? orNull(goalRepo.countMonth(orgId, month)) : null,
      used.has("tasks_done") || used.has("tasks_done_rate") ? orNull(goalSources.teamTasks(ctx, month)) : null,
      used.has("lp_visitors") ? orNull(goalSources.lpVisitors(ctx, month)) : null,
    ]);
    return { member, tasks: tasks && new Map(tasks.map((t) => [t.teamId, t])), lpVisitors };
  }

  private toGoal(r: GoalRow, a: Actuals): goal.TeamGoal {
    const { orgId: _o, kpis, ...rest } = r;
    const progress = kpis.map((k) => progressOf(k, r.teamId, a));
    return { ...rest, kpis: progress, percent: goal.goalPercent(progress) };
  }

  async list(ctx: ReqCtx, month: string | undefined): Promise<goal.ListGoalsResponse> {
    const { goalRepo, orgId, repo } = this.deps;
    const target = month ?? goal.currentMonth(new Date(this.deps.now()));
    if (!goal.isMonth(target)) throw errors.validationFailed([{ field: "month", reason: "invalid" }]);
    const [teams, rows] = await Promise.all([repo.listTeams(orgId), goalRepo.list(orgId, target)]);
    const actuals = await this.collect(ctx, target, rows);
    return {
      month: target,
      teams: teams.map((t) => ({ id: t.id, name: t.name, color: t.color })),
      goals: rows.map((r) => this.toGoal(r, actuals)),
    };
  }

  async put(ctx: ReqCtx, teamId: string, month: string, body: goal.PutGoalRequest): Promise<goal.TeamGoal> {
    const { goalRepo, orgId, repo, now } = this.deps;
    if (!goal.isMonth(month)) throw errors.validationFailed([{ field: "month", reason: "invalid" }]);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title.length === 0 || title.length > goal.GOAL_TITLE_MAX) throw errors.validationFailed([{ field: "title", reason: "invalid" }]);
    if (!Number.isInteger(body.expectedVersion)) throw errors.validationFailed([{ field: "expectedVersion", reason: "required" }]);
    const kpis = parseKpis(body.kpis);
    const teams = await repo.listTeams(orgId);
    if (!teams.some((t) => t.id === teamId)) throw errTeamNotFound(teamId);
    const person = await repo.getPersonByIdentityUserId(orgId, ctx.userId);
    const row: GoalRow = {
      orgId, teamId, month, title, kpis,
      version: body.expectedVersion + 1,
      updatedBy: ctx.userId,
      updatedByName: person?.name ?? null,
      updatedAt: now(),
    };
    if (!(await goalRepo.save(row, body.expectedVersion))) throw errVersionConflict();
    return this.toGoal(row, await this.collect(ctx, month, [row]));
  }

  async remove(teamId: string, month: string): Promise<void> {
    const { goalRepo, orgId } = this.deps;
    if (!goal.isMonth(month)) throw errors.validationFailed([{ field: "month", reason: "invalid" }]);
    if (!(await goalRepo.get(orgId, teamId, month))) throw errGoalNotFound();
    await goalRepo.remove(orgId, teamId, month);
  }
}
