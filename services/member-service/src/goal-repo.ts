// 目標管理 (member_goals) の永続化と、実績の取り口。同じ D1 `member` namespace の人事・スポンサー・
// 参加届は直接数え、他サービスのデータは Service Binding の内部 API から件数だけもらう。
import type { DbClient } from "@dub/db";
import { createServiceClient, type RequestContext } from "@dub/http";
import type { common, goal } from "@dub/types";
import type { Env } from "./env";

export interface GoalRow {
  orgId: common.OrgId;
  teamId: common.TeamId;
  month: string;
  title: string;
  kpis: goal.Kpi[];
  version: number;
  updatedBy: common.UserId;
  updatedByName: string | null;
  updatedAt: common.ISODateTime;
}

/** member namespace 内で数えられる、その月の団体全体の件数。 */
export interface MemberMonthCounts {
  hr_applicants: number;
  hr_interviews: number;
  hr_hired: number;
  sponsor_cards: number;
  sponsor_contacted: number;
  sponsor_proposed: number;
  sponsor_agreed: number;
  sponsor_amount: number;
  participations: number;
}

const NO_COUNTS: MemberMonthCounts = {
  hr_applicants: 0, hr_interviews: 0, hr_hired: 0, sponsor_cards: 0,
  sponsor_contacted: 0, sponsor_proposed: 0, sponsor_agreed: 0, sponsor_amount: 0, participations: 0,
};

export interface GoalRepo {
  list(orgId: common.OrgId, month: string): Promise<GoalRow[]>;
  get(orgId: common.OrgId, teamId: common.TeamId, month: string): Promise<GoalRow | null>;
  /** 新規 = expectedVersion 0。楽観ロックに負けたら false。 */
  save(row: GoalRow, expectedVersion: number): Promise<boolean>;
  remove(orgId: common.OrgId, teamId: common.TeamId, month: string): Promise<void>;
  countMonth(orgId: common.OrgId, month: string): Promise<MemberMonthCounts>;
}

export interface TeamTaskCounts {
  teamId: common.TeamId;
  dueTotal: number;
  dueDone: number;
}

/** 他サービスの実績。失敗は呼び出し側で「集計できません」にする (0 と区別する)。 */
export interface GoalMetricSources {
  teamTasks(ctx: RequestContext, month: string): Promise<TeamTaskCounts[]>;
  lpVisitors(ctx: RequestContext, month: string): Promise<number>;
}

/** 依存先が止まっても一覧は gateway の時間内に返す (失敗した KPI だけ「集計できません」)。 */
const CALL = { timeoutMs: 3_000, retry: false } as const;

export function createGoalSources(env: Pick<Env, "SVC_TASK" | "SVC_LP_ANALYTICS">): GoalMetricSources {
  return {
    async teamTasks(ctx, month) {
      if (!env.SVC_TASK) throw new Error("SVC_TASK binding is absent");
      const client = createServiceClient(env.SVC_TASK, { service: "task-service", caller: "member-service" });
      return (await client.get<{ teams: TeamTaskCounts[] }>(ctx, `/internal/goal-metrics?month=${month}`, CALL)).teams;
    },
    async lpVisitors(ctx, month) {
      if (!env.SVC_LP_ANALYTICS) throw new Error("SVC_LP_ANALYTICS binding is absent");
      const client = createServiceClient(env.SVC_LP_ANALYTICS, { service: "lp-analytics", caller: "member-service" });
      return (await client.get<{ visitors: number }>(ctx, `/lp/internal/goal-metrics?month=${month}`, CALL)).visitors;
    },
  };
}

interface DbRow {
  org_id: string;
  team_id: string;
  month: string;
  title: string;
  kpis_json: string;
  version: number;
  updated_by: string;
  updated_by_name: string | null;
  updated_at: string;
}

const toRow = (r: DbRow): GoalRow => ({
  orgId: r.org_id,
  teamId: r.team_id,
  month: r.month,
  title: r.title,
  kpis: JSON.parse(r.kpis_json) as goal.Kpi[],
  version: r.version,
  updatedBy: r.updated_by,
  updatedByName: r.updated_by_name,
  updatedAt: r.updated_at,
});

/** UTC の ISO 日時 → 日本時間の YYYY-MM。 */
const jstMonth = (col: string): string => `substr(datetime(${col}, '+9 hours'), 1, 7)`;

export function createD1GoalRepo(db: DbClient): GoalRepo {
  return {
    async list(orgId, month) {
      const rows = await db.all<DbRow>(`SELECT * FROM member_goals WHERE org_id = ? AND month = ?`, orgId, month);
      return rows.map(toRow);
    },
    async get(orgId, teamId, month) {
      const r = await db.first<DbRow>(`SELECT * FROM member_goals WHERE org_id = ? AND team_id = ? AND month = ?`, orgId, teamId, month);
      return r ? toRow(r) : null;
    },
    async save(row, expectedVersion) {
      const kpis = JSON.stringify(row.kpis);
      if (expectedVersion === 0) {
        const res = await db.run(
          `INSERT OR IGNORE INTO member_goals (org_id, team_id, month, title, kpis_json, version, updated_by, updated_by_name, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.orgId, row.teamId, row.month, row.title, kpis, row.version, row.updatedBy, row.updatedByName, row.updatedAt,
        );
        return res.meta.changes > 0;
      }
      const res = await db.run(
        `UPDATE member_goals SET title = ?, kpis_json = ?, version = ?, updated_by = ?, updated_by_name = ?, updated_at = ?
         WHERE org_id = ? AND team_id = ? AND month = ? AND version = ?`,
        row.title, kpis, row.version, row.updatedBy, row.updatedByName, row.updatedAt, row.orgId, row.teamId, row.month, expectedVersion,
      );
      return res.meta.changes > 0;
    },
    async remove(orgId, teamId, month) {
      await db.run(`DELETE FROM member_goals WHERE org_id = ? AND team_id = ? AND month = ?`, orgId, teamId, month);
    },
    async countMonth(orgId, month) {
      const r = await db.first<MemberMonthCounts>(
        `SELECT
           (SELECT COUNT(*) FROM member_hr_applicants
             WHERE org_id = ?1 AND archived_at IS NULL AND ${jstMonth("created_at")} = ?2) AS hr_applicants,
           (SELECT COUNT(*) FROM member_hr_applicants
             WHERE org_id = ?1 AND archived_at IS NULL AND ${jstMonth("interview_at")} = ?2) AS hr_interviews,
           (SELECT COUNT(DISTINCT e.applicant_id) FROM member_hr_events e
             JOIN member_hr_applicants a ON a.id = e.applicant_id
             WHERE a.org_id = ?1 AND a.archived_at IS NULL AND e.to_stage = 'hired' AND ${jstMonth("e.created_at")} = ?2) AS hr_hired,
           (SELECT COUNT(*) FROM member_sponsor_cards
             WHERE org_id = ?1 AND archived_at IS NULL AND ${jstMonth("created_at")} = ?2) AS sponsor_cards,
           (SELECT COUNT(*) FROM member_sponsor_leads
             WHERE org_id = ?1 AND archived_at IS NULL AND substr(first_contact_on, 1, 7) = ?2) AS sponsor_contacted,
           (SELECT COUNT(*) FROM member_sponsor_leads
             WHERE org_id = ?1 AND archived_at IS NULL AND substr(proposed_on, 1, 7) = ?2) AS sponsor_proposed,
           (SELECT COUNT(*) FROM member_sponsor_leads
             WHERE org_id = ?1 AND archived_at IS NULL AND status <> '見送り' AND substr(agreed_on, 1, 7) = ?2) AS sponsor_agreed,
           (SELECT COALESCE(SUM(expected_amount), 0) FROM member_sponsor_leads
             WHERE org_id = ?1 AND archived_at IS NULL AND status <> '見送り' AND substr(agreed_on, 1, 7) = ?2) AS sponsor_amount,
           (SELECT COUNT(*) FROM member_participations
             WHERE org_id = ?1 AND ${jstMonth("submitted_at")} = ?2) AS participations`,
        orgId,
        month,
      );
      return r ?? { ...NO_COUNTS };
    },
  };
}

/** テスト用。件数は counts を直接差し替える。 */
export class InMemoryGoalRepo implements GoalRepo {
  rows = new Map<string, GoalRow>();
  counts: MemberMonthCounts = { ...NO_COUNTS };

  private key = (orgId: string, teamId: string, month: string): string => `${orgId}|${teamId}|${month}`;

  async list(orgId: string, month: string): Promise<GoalRow[]> {
    return [...this.rows.values()].filter((r) => r.orgId === orgId && r.month === month);
  }
  async get(orgId: string, teamId: string, month: string): Promise<GoalRow | null> {
    return this.rows.get(this.key(orgId, teamId, month)) ?? null;
  }
  async save(row: GoalRow, expectedVersion: number): Promise<boolean> {
    const key = this.key(row.orgId, row.teamId, row.month);
    if ((this.rows.get(key)?.version ?? 0) !== expectedVersion) return false;
    this.rows.set(key, row);
    return true;
  }
  async remove(orgId: string, teamId: string, month: string): Promise<void> {
    this.rows.delete(this.key(orgId, teamId, month));
  }
  async countMonth(): Promise<MemberMonthCounts> {
    return this.counts;
  }
}
