// 人事 (member_hr_*) の永続化。名簿 (MemberRepo) とは別インタフェースにして、人事の追加が
// 名簿のリポジトリを太らせないようにする。同じ D1 `member` namespace を共有する。
import type { DbClient } from "@dub/db";
import { hr, type common } from "@dub/types";

/** 応募者の永続化行 (wire Applicant + org / 論理削除)。 */
export interface ApplicantRow extends hr.Applicant {
  orgId: common.OrgId;
  archivedAt: common.ISODateTime | null;
}

export interface OnboardingCheckRow {
  personId: string;
  itemId: string;
  checkedBy: common.UserId;
  checkedAt: common.ISODateTime;
}

export interface HrRepo {
  createApplicant(row: ApplicantRow): Promise<void>;
  getApplicant(id: string): Promise<ApplicantRow | null>;
  /** 論理削除済みを除く。作成日時の新しい順。 */
  listApplicants(orgId: common.OrgId): Promise<ApplicantRow[]>;
  /** 楽観ロック: version が expectedVersion のときだけ更新し true。 */
  updateApplicant(next: ApplicantRow, expectedVersion: number): Promise<boolean>;
  addEvent(ev: hr.ApplicantEvent): Promise<void>;
  /** 古い順。 */
  listEvents(applicantId: string): Promise<hr.ApplicantEvent[]>;
  listOnboardingChecks(personIds: readonly string[]): Promise<OnboardingCheckRow[]>;
  setOnboardingCheck(row: OnboardingCheckRow, checked: boolean): Promise<void>;
}

const byCreatedDesc = (a: ApplicantRow, b: ApplicantRow): number =>
  a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1;

export class InMemoryHrRepo implements HrRepo {
  private applicants = new Map<string, ApplicantRow>();
  private events: hr.ApplicantEvent[] = [];
  private checks = new Map<string, OnboardingCheckRow>(); // personId|itemId

  async createApplicant(row: ApplicantRow): Promise<void> {
    this.applicants.set(row.id, { ...row });
  }
  async getApplicant(id: string): Promise<ApplicantRow | null> {
    const r = this.applicants.get(id);
    return r ? { ...r } : null;
  }
  async listApplicants(orgId: common.OrgId): Promise<ApplicantRow[]> {
    return [...this.applicants.values()]
      .filter((a) => a.orgId === orgId && a.archivedAt === null)
      .sort(byCreatedDesc)
      .map((a) => ({ ...a }));
  }
  async updateApplicant(next: ApplicantRow, expectedVersion: number): Promise<boolean> {
    const cur = this.applicants.get(next.id);
    if (!cur || cur.version !== expectedVersion) return false;
    this.applicants.set(next.id, { ...next });
    return true;
  }
  async addEvent(ev: hr.ApplicantEvent): Promise<void> {
    this.events.push({ ...ev });
  }
  async listEvents(applicantId: string): Promise<hr.ApplicantEvent[]> {
    return this.events.filter((e) => e.applicantId === applicantId).map((e) => ({ ...e }));
  }
  async listOnboardingChecks(personIds: readonly string[]): Promise<OnboardingCheckRow[]> {
    const set = new Set(personIds);
    return [...this.checks.values()].filter((c) => set.has(c.personId)).map((c) => ({ ...c }));
  }
  async setOnboardingCheck(row: OnboardingCheckRow, checked: boolean): Promise<void> {
    const key = `${row.personId}|${row.itemId}`;
    if (checked) this.checks.set(key, { ...row });
    else this.checks.delete(key);
  }
}

interface ApplicantDbRow {
  id: string;
  org_id: string;
  name: string;
  name_kana: string | null;
  email: string | null;
  department: string | null;
  grade: string | null;
  desired_team_id: string | null;
  source: string | null;
  motivation: string | null;
  stage: string;
  member_id: string | null;
  participation_id: string | null;
  version: number;
  archived_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface EventDbRow {
  id: string;
  applicant_id: string;
  kind: string;
  from_stage: string | null;
  to_stage: string | null;
  body: string | null;
  actor_id: string;
  created_at: string;
}

function stageOf(v: string | null): hr.ApplicantStage | null {
  return v !== null && hr.isApplicantStage(v) ? v : null;
}

function toApplicantRow(r: ApplicantDbRow): ApplicantRow {
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    nameKana: r.name_kana,
    email: r.email,
    department: r.department,
    grade: r.grade,
    desiredTeamId: r.desired_team_id,
    source: r.source,
    motivation: r.motivation,
    stage: stageOf(r.stage) ?? "applied",
    memberId: r.member_id,
    participationId: r.participation_id,
    version: r.version,
    archivedAt: r.archived_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toEvent(r: EventDbRow): hr.ApplicantEvent {
  return {
    id: r.id,
    applicantId: r.applicant_id,
    kind: r.kind as hr.ApplicantEventKind,
    fromStage: stageOf(r.from_stage),
    toStage: stageOf(r.to_stage),
    body: r.body,
    actorId: r.actor_id,
    createdAt: r.created_at,
  };
}

export function createD1HrRepo(db: DbClient): HrRepo {
  return {
    async createApplicant(a) {
      await db.run(
        `INSERT INTO member_hr_applicants (id, org_id, name, name_kana, email, department, grade, desired_team_id, source,
           motivation, stage, member_id, participation_id, version, archived_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id, a.orgId, a.name, a.nameKana, a.email, a.department, a.grade, a.desiredTeamId, a.source,
        a.motivation, a.stage, a.memberId, a.participationId, a.version, a.archivedAt, a.createdBy, a.createdAt, a.updatedAt,
      );
    },
    async getApplicant(id) {
      const r = await db.first<ApplicantDbRow>(`SELECT * FROM member_hr_applicants WHERE id = ?`, id);
      return r ? toApplicantRow(r) : null;
    },
    async listApplicants(orgId) {
      const rows = await db.all<ApplicantDbRow>(
        `SELECT * FROM member_hr_applicants WHERE org_id = ? AND archived_at IS NULL ORDER BY created_at DESC, id DESC`,
        orgId,
      );
      return rows.map(toApplicantRow);
    },
    async updateApplicant(a, expectedVersion) {
      const res = await db.run(
        `UPDATE member_hr_applicants SET name = ?, name_kana = ?, email = ?, department = ?, grade = ?, desired_team_id = ?,
           source = ?, motivation = ?, stage = ?, member_id = ?, participation_id = ?, version = ?, archived_at = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
        a.name, a.nameKana, a.email, a.department, a.grade, a.desiredTeamId,
        a.source, a.motivation, a.stage, a.memberId, a.participationId, a.version, a.archivedAt, a.updatedAt,
        a.id, expectedVersion,
      );
      return res.meta.changes > 0;
    },
    async addEvent(e) {
      await db.run(
        `INSERT INTO member_hr_events (id, applicant_id, kind, from_stage, to_stage, body, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        e.id, e.applicantId, e.kind, e.fromStage, e.toStage, e.body, e.actorId, e.createdAt,
      );
    },
    async listEvents(applicantId) {
      const rows = await db.all<EventDbRow>(
        `SELECT * FROM member_hr_events WHERE applicant_id = ? ORDER BY created_at ASC, id ASC`,
        applicantId,
      );
      return rows.map(toEvent);
    },
    async listOnboardingChecks(personIds) {
      if (personIds.length === 0) return [];
      const marks = personIds.map(() => "?").join(", ");
      const rows = await db.all<{ person_id: string; item_id: string; checked_by: string; checked_at: string }>(
        `SELECT * FROM member_hr_onboarding_checks WHERE person_id IN (${marks})`,
        ...personIds,
      );
      return rows.map((r) => ({ personId: r.person_id, itemId: r.item_id, checkedBy: r.checked_by, checkedAt: r.checked_at }));
    },
    async setOnboardingCheck(row, checked) {
      if (checked) {
        await db.run(
          `INSERT OR REPLACE INTO member_hr_onboarding_checks (person_id, item_id, checked_by, checked_at) VALUES (?, ?, ?, ?)`,
          row.personId, row.itemId, row.checkedBy, row.checkedAt,
        );
      } else {
        await db.run(`DELETE FROM member_hr_onboarding_checks WHERE person_id = ? AND item_id = ?`, row.personId, row.itemId);
      }
    },
  };
}
