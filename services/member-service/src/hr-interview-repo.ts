// 面談の日程調整 (member_hr_interview_*) の永続化。応募者 (HrRepo) とは別インタフェースにして、
// 応募者のリポジトリを太らせない。同じ D1 `member` namespace。
import type { DbClient } from "@dub/db";
import type { common } from "@dub/types";

export interface SlotRow {
  id: string;
  orgId: common.OrgId;
  startAt: common.ISODateTime;
  endAt: common.ISODateTime;
  interviewerId: common.UserId;
  interviewerName: string;
  applicantId: string | null;
  bookedAt: common.ISODateTime | null;
  createdAt: common.ISODateTime;
}

export interface InviteRow {
  id: string;
  orgId: common.OrgId;
  applicantId: string;
  token: string;
  /** 送信を試みた回数。冪等キーの区切りと、失敗し続ける宛先を後ろへ回すために使う。 */
  attempts: number;
  sentAt: common.ISODateTime | null;
  lastError: string | null;
  createdAt: common.ISODateTime;
}

export interface HrInterviewRepo {
  /** 開始が since 以降の枠。開始の早い順。 */
  listSlots(orgId: common.OrgId, since: common.ISODateTime): Promise<SlotRow[]>;
  getSlot(id: string): Promise<SlotRow | null>;
  findSlotByApplicant(applicantId: string): Promise<SlotRow | null>;
  /** 同じ担当者・同じ開始の枠が既にあれば false。 */
  addSlot(row: SlotRow): Promise<boolean>;
  /** 予約の無い枠だけ消す。消せたら true。 */
  deleteOpenSlot(id: string): Promise<boolean>;
  /** 枠が空いていて、応募者がまだどの枠も持っていないときだけ予約して true (同時押しはここで 1 人に絞る)。 */
  bookSlot(id: string, applicantId: string, bookedAt: common.ISODateTime): Promise<boolean>;
  /** 予約を外す。この応募者の予約が外れたら true。 */
  releaseSlot(id: string, applicantId: string): Promise<boolean>;

  /** 既に招待があれば何もしない。 */
  addInvite(row: InviteRow): Promise<void>;
  getInvite(id: string): Promise<InviteRow | null>;
  getInviteByToken(token: string): Promise<InviteRow | null>;
  getInviteByApplicant(applicantId: string): Promise<InviteRow | null>;
  /** 新しい順。 */
  listInvites(orgId: common.OrgId): Promise<InviteRow[]>;
  markInviteSent(id: string, sentAt: common.ISODateTime): Promise<void>;
  markInviteFailed(id: string, error: string): Promise<void>;
  countInvitesSentSince(orgId: common.OrgId, since: common.ISODateTime): Promise<number>;

  getMinOpenSlots(orgId: common.OrgId): Promise<number | null>;
  saveMinOpenSlots(orgId: common.OrgId, value: number, userId: common.UserId, at: common.ISODateTime): Promise<void>;
}

const byStart = (a: SlotRow, b: SlotRow): number =>
  a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : a.id < b.id ? -1 : 1;
const byCreatedDesc = (a: InviteRow, b: InviteRow): number =>
  a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1;

export class InMemoryHrInterviewRepo implements HrInterviewRepo {
  private slots = new Map<string, SlotRow>();
  private invites = new Map<string, InviteRow>();
  private settings = new Map<string, number>();

  async listSlots(orgId: common.OrgId, since: common.ISODateTime): Promise<SlotRow[]> {
    return [...this.slots.values()].filter((s) => s.orgId === orgId && s.startAt >= since).sort(byStart).map((s) => ({ ...s }));
  }
  async getSlot(id: string): Promise<SlotRow | null> {
    const s = this.slots.get(id);
    return s ? { ...s } : null;
  }
  async findSlotByApplicant(applicantId: string): Promise<SlotRow | null> {
    const s = [...this.slots.values()].find((x) => x.applicantId === applicantId);
    return s ? { ...s } : null;
  }
  async addSlot(row: SlotRow): Promise<boolean> {
    const dup = [...this.slots.values()].some(
      (s) => s.orgId === row.orgId && s.interviewerId === row.interviewerId && s.startAt === row.startAt,
    );
    if (dup) return false;
    this.slots.set(row.id, { ...row });
    return true;
  }
  async deleteOpenSlot(id: string): Promise<boolean> {
    if (this.slots.get(id)?.applicantId !== null) return false;
    return this.slots.delete(id);
  }
  async bookSlot(id: string, applicantId: string, bookedAt: common.ISODateTime): Promise<boolean> {
    const s = this.slots.get(id);
    if (!s || s.applicantId !== null || [...this.slots.values()].some((x) => x.applicantId === applicantId)) return false;
    this.slots.set(id, { ...s, applicantId, bookedAt });
    return true;
  }
  async releaseSlot(id: string, applicantId: string): Promise<boolean> {
    const s = this.slots.get(id);
    if (!s || s.applicantId !== applicantId) return false;
    this.slots.set(id, { ...s, applicantId: null, bookedAt: null });
    return true;
  }
  async addInvite(row: InviteRow): Promise<void> {
    if (![...this.invites.values()].some((i) => i.applicantId === row.applicantId)) this.invites.set(row.id, { ...row });
  }
  async getInvite(id: string): Promise<InviteRow | null> {
    const i = this.invites.get(id);
    return i ? { ...i } : null;
  }
  async getInviteByToken(token: string): Promise<InviteRow | null> {
    const i = [...this.invites.values()].find((x) => x.token === token);
    return i ? { ...i } : null;
  }
  async getInviteByApplicant(applicantId: string): Promise<InviteRow | null> {
    const i = [...this.invites.values()].find((x) => x.applicantId === applicantId);
    return i ? { ...i } : null;
  }
  async listInvites(orgId: common.OrgId): Promise<InviteRow[]> {
    return [...this.invites.values()].filter((i) => i.orgId === orgId).sort(byCreatedDesc).map((i) => ({ ...i }));
  }
  async markInviteSent(id: string, sentAt: common.ISODateTime): Promise<void> {
    const i = this.invites.get(id);
    if (i) this.invites.set(id, { ...i, sentAt, lastError: null, attempts: i.attempts + 1 });
  }
  async markInviteFailed(id: string, error: string): Promise<void> {
    const i = this.invites.get(id);
    if (i) this.invites.set(id, { ...i, lastError: error, attempts: i.attempts + 1 });
  }
  async countInvitesSentSince(orgId: common.OrgId, since: common.ISODateTime): Promise<number> {
    return [...this.invites.values()].filter((i) => i.orgId === orgId && i.sentAt !== null && i.sentAt >= since).length;
  }
  async getMinOpenSlots(orgId: common.OrgId): Promise<number | null> {
    return this.settings.get(orgId) ?? null;
  }
  async saveMinOpenSlots(orgId: common.OrgId, value: number): Promise<void> {
    this.settings.set(orgId, value);
  }
}

interface SlotDbRow {
  id: string;
  org_id: string;
  start_at: string;
  end_at: string;
  interviewer_id: string;
  interviewer_name: string;
  applicant_id: string | null;
  booked_at: string | null;
  created_at: string;
}
interface InviteDbRow {
  id: string;
  org_id: string;
  applicant_id: string;
  token: string;
  attempts: number;
  sent_at: string | null;
  last_error: string | null;
  created_at: string;
}

const toSlot = (r: SlotDbRow): SlotRow => ({
  id: r.id,
  orgId: r.org_id,
  startAt: r.start_at,
  endAt: r.end_at,
  interviewerId: r.interviewer_id,
  interviewerName: r.interviewer_name,
  applicantId: r.applicant_id,
  bookedAt: r.booked_at,
  createdAt: r.created_at,
});
const toInvite = (r: InviteDbRow): InviteRow => ({
  id: r.id,
  orgId: r.org_id,
  applicantId: r.applicant_id,
  token: r.token,
  attempts: r.attempts,
  sentAt: r.sent_at,
  lastError: r.last_error,
  createdAt: r.created_at,
});

export function createD1HrInterviewRepo(db: DbClient): HrInterviewRepo {
  return {
    async listSlots(orgId, since) {
      const rows = await db.all<SlotDbRow>(
        `SELECT * FROM member_hr_interview_slots WHERE org_id = ? AND start_at >= ? ORDER BY start_at, id LIMIT 500`,
        orgId, since,
      );
      return rows.map(toSlot);
    },
    async getSlot(id) {
      const r = await db.first<SlotDbRow>(`SELECT * FROM member_hr_interview_slots WHERE id = ?`, id);
      return r ? toSlot(r) : null;
    },
    async findSlotByApplicant(applicantId) {
      const r = await db.first<SlotDbRow>(`SELECT * FROM member_hr_interview_slots WHERE applicant_id = ?`, applicantId);
      return r ? toSlot(r) : null;
    },
    async addSlot(s) {
      const res = await db.run(
        `INSERT OR IGNORE INTO member_hr_interview_slots (id, org_id, start_at, end_at, interviewer_id, interviewer_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        s.id, s.orgId, s.startAt, s.endAt, s.interviewerId, s.interviewerName, s.createdAt,
      );
      return res.meta.changes > 0;
    },
    async deleteOpenSlot(id) {
      const res = await db.run(`DELETE FROM member_hr_interview_slots WHERE id = ? AND applicant_id IS NULL`, id);
      return res.meta.changes > 0;
    },
    async bookSlot(id, applicantId, bookedAt) {
      // 1 文で判定して原子的にする。部分 UNIQUE は最後の砦 (@dub/db の namespace ガードは UPDATE OR IGNORE を通さない)。
      const res = await db.run(
        `UPDATE member_hr_interview_slots SET applicant_id = ?, booked_at = ?
         WHERE id = ? AND applicant_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM member_hr_interview_slots WHERE applicant_id = ?)`,
        applicantId, bookedAt, id, applicantId,
      );
      return res.meta.changes > 0;
    },
    async releaseSlot(id, applicantId) {
      const res = await db.run(
        `UPDATE member_hr_interview_slots SET applicant_id = NULL, booked_at = NULL WHERE id = ? AND applicant_id = ?`,
        id, applicantId,
      );
      return res.meta.changes > 0;
    },
    async addInvite(i) {
      await db.run(
        `INSERT OR IGNORE INTO member_hr_interview_invites (id, org_id, applicant_id, token, attempts, sent_at, last_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        i.id, i.orgId, i.applicantId, i.token, i.attempts, i.sentAt, i.lastError, i.createdAt,
      );
    },
    async getInvite(id) {
      const r = await db.first<InviteDbRow>(`SELECT * FROM member_hr_interview_invites WHERE id = ?`, id);
      return r ? toInvite(r) : null;
    },
    async getInviteByToken(token) {
      const r = await db.first<InviteDbRow>(`SELECT * FROM member_hr_interview_invites WHERE token = ?`, token);
      return r ? toInvite(r) : null;
    },
    async getInviteByApplicant(applicantId) {
      const r = await db.first<InviteDbRow>(`SELECT * FROM member_hr_interview_invites WHERE applicant_id = ?`, applicantId);
      return r ? toInvite(r) : null;
    },
    async listInvites(orgId) {
      const rows = await db.all<InviteDbRow>(
        `SELECT * FROM member_hr_interview_invites WHERE org_id = ? ORDER BY created_at DESC, id DESC LIMIT 500`,
        orgId,
      );
      return rows.map(toInvite);
    },
    async markInviteSent(id, sentAt) {
      await db.run(
        `UPDATE member_hr_interview_invites SET sent_at = ?, last_error = NULL, attempts = attempts + 1 WHERE id = ?`,
        sentAt, id,
      );
    },
    async markInviteFailed(id, error) {
      await db.run(`UPDATE member_hr_interview_invites SET last_error = ?, attempts = attempts + 1 WHERE id = ?`, error, id);
    },
    async countInvitesSentSince(orgId, since) {
      const r = await db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM member_hr_interview_invites WHERE org_id = ? AND sent_at >= ?`,
        orgId, since,
      );
      return r?.n ?? 0;
    },
    async getMinOpenSlots(orgId) {
      const r = await db.first<{ min_open_slots: number }>(
        `SELECT min_open_slots FROM member_hr_interview_settings WHERE org_id = ?`,
        orgId,
      );
      return r?.min_open_slots ?? null;
    },
    async saveMinOpenSlots(orgId, value, userId, at) {
      await db.run(
        `INSERT INTO member_hr_interview_settings (org_id, min_open_slots, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET min_open_slots = excluded.min_open_slots, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        orgId, value, userId, at,
      );
    },
  };
}
