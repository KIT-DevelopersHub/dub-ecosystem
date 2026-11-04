// 面談申し込みフォーム (member_hr_forms / member_hr_form_responses) の永続化。人事の応募者 (HrRepo) とは
// 別インタフェースにして、フォームの追加が応募者のリポジトリを太らせないようにする。同じ D1 `member` namespace。
import type { DbClient } from "@dub/db";
import type { common, hrForm } from "@dub/types";

/** フォーム定義の永続化行。form_key は今は "interview" のみ (将来フォームを増やせる形)。 */
export interface HrFormRow {
  orgId: common.OrgId;
  formKey: string;
  title: string;
  description: string | null;
  questions: hrForm.FormQuestion[];
  accepting: boolean;
  version: number;
  updatedBy: common.UserId;
  createdAt: common.ISODateTime;
  updatedAt: common.ISODateTime;
}

export interface HrFormResponseRow extends hrForm.InterviewFormResponse {
  orgId: common.OrgId;
  formKey: string;
}

export interface HrFormRepo {
  getForm(orgId: common.OrgId, formKey: string): Promise<HrFormRow | null>;
  /** 新規作成。既に行があれば false。 */
  insertForm(row: HrFormRow): Promise<boolean>;
  /** 楽観ロック: version が expectedVersion のときだけ更新し true。 */
  updateForm(row: HrFormRow, expectedVersion: number): Promise<boolean>;
  addResponse(row: HrFormResponseRow): Promise<void>;
  /** 新しい順。applicantId を渡すとその応募者の回答だけ。 */
  listResponses(orgId: common.OrgId, formKey: string, applicantId?: string): Promise<HrFormResponseRow[]>;
}

const byCreatedDesc = (a: HrFormResponseRow, b: HrFormResponseRow): number =>
  a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class InMemoryHrFormRepo implements HrFormRepo {
  private forms = new Map<string, HrFormRow>(); // orgId|formKey
  private responses: HrFormResponseRow[] = [];

  async getForm(orgId: common.OrgId, formKey: string): Promise<HrFormRow | null> {
    const r = this.forms.get(`${orgId}|${formKey}`);
    return r ? clone(r) : null;
  }
  async insertForm(row: HrFormRow): Promise<boolean> {
    const key = `${row.orgId}|${row.formKey}`;
    if (this.forms.has(key)) return false;
    this.forms.set(key, clone(row));
    return true;
  }
  async updateForm(row: HrFormRow, expectedVersion: number): Promise<boolean> {
    const key = `${row.orgId}|${row.formKey}`;
    const cur = this.forms.get(key);
    if (!cur || cur.version !== expectedVersion) return false;
    this.forms.set(key, clone(row));
    return true;
  }
  async addResponse(row: HrFormResponseRow): Promise<void> {
    this.responses.push(clone(row));
  }
  async listResponses(orgId: common.OrgId, formKey: string, applicantId?: string): Promise<HrFormResponseRow[]> {
    return this.responses
      .filter((r) => r.orgId === orgId && r.formKey === formKey && (applicantId === undefined || r.applicantId === applicantId))
      .sort(byCreatedDesc)
      .map(clone);
  }
}

interface FormDbRow {
  org_id: string;
  form_key: string;
  title: string;
  description: string | null;
  questions_json: string;
  accepting: number;
  version: number;
  updated_by: string;
  created_at: string;
  updated_at: string;
}
interface ResponseDbRow {
  id: string;
  org_id: string;
  form_key: string;
  applicant_id: string;
  answers_json: string;
  questions_json: string;
  via: string;
  submitted_by: string;
  created_at: string;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toFormRow(r: FormDbRow): HrFormRow {
  return {
    orgId: r.org_id,
    formKey: r.form_key,
    title: r.title,
    description: r.description,
    questions: parseJson<hrForm.FormQuestion[]>(r.questions_json, []),
    accepting: r.accepting !== 0,
    version: r.version,
    updatedBy: r.updated_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toResponseRow(r: ResponseDbRow): HrFormResponseRow {
  return {
    id: r.id,
    orgId: r.org_id,
    formKey: r.form_key,
    applicantId: r.applicant_id,
    answers: parseJson<hrForm.FormAnswers>(r.answers_json, {}),
    questions: parseJson<hrForm.FormQuestion[]>(r.questions_json, []),
    via: r.via === "staff" ? "staff" : "public",
    submittedBy: r.submitted_by,
    createdAt: r.created_at,
  };
}

export function createD1HrFormRepo(db: DbClient): HrFormRepo {
  return {
    async getForm(orgId, formKey) {
      const r = await db.first<FormDbRow>(`SELECT * FROM member_hr_forms WHERE org_id = ? AND form_key = ?`, orgId, formKey);
      return r ? toFormRow(r) : null;
    },
    async insertForm(f) {
      const res = await db.run(
        `INSERT OR IGNORE INTO member_hr_forms (org_id, form_key, title, description, questions_json, accepting, version, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        f.orgId, f.formKey, f.title, f.description, JSON.stringify(f.questions), f.accepting ? 1 : 0, f.version, f.updatedBy, f.createdAt, f.updatedAt,
      );
      return res.meta.changes > 0;
    },
    async updateForm(f, expectedVersion) {
      const res = await db.run(
        `UPDATE member_hr_forms SET title = ?, description = ?, questions_json = ?, accepting = ?, version = ?, updated_by = ?, updated_at = ?
         WHERE org_id = ? AND form_key = ? AND version = ?`,
        f.title, f.description, JSON.stringify(f.questions), f.accepting ? 1 : 0, f.version, f.updatedBy, f.updatedAt,
        f.orgId, f.formKey, expectedVersion,
      );
      return res.meta.changes > 0;
    },
    async addResponse(r) {
      await db.run(
        `INSERT INTO member_hr_form_responses (id, org_id, form_key, applicant_id, answers_json, questions_json, via, submitted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r.id, r.orgId, r.formKey, r.applicantId, JSON.stringify(r.answers), JSON.stringify(r.questions), r.via, r.submittedBy, r.createdAt,
      );
    },
    async listResponses(orgId, formKey, applicantId) {
      const rows = applicantId
        ? await db.all<ResponseDbRow>(
            `SELECT * FROM member_hr_form_responses WHERE org_id = ? AND form_key = ? AND applicant_id = ? ORDER BY created_at DESC, id DESC`,
            orgId, formKey, applicantId,
          )
        : await db.all<ResponseDbRow>(
            `SELECT * FROM member_hr_form_responses WHERE org_id = ? AND form_key = ? ORDER BY created_at DESC, id DESC LIMIT 500`,
            orgId, formKey,
          );
      return rows.map(toResponseRow);
    },
  };
}
