// スポンサー (member_sponsor_cards) の永続化と、名刺写真の置き場 (R2) のポート。名簿 / 人事の
// リポジトリとは別インタフェースにして、スポンサーの追加がそれらを太らせないようにする。
// 同じ D1 `member` namespace を共有する。
import type { DbClient } from "@dub/db";
import type { R2Bucket } from "@cloudflare/workers-types";
import type { common, sponsor } from "@dub/types";

/** 名刺の永続化行 (wire BusinessCard から hasImage を除き、写真の形式 / org / 論理削除を持つ)。 */
export interface CardRow extends Omit<sponsor.BusinessCard, "hasImage"> {
  orgId: common.OrgId;
  /** 保存した写真の Content-Type。null = 写真なし。 */
  imageContentType: string | null;
  archivedAt: common.ISODateTime | null;
}

export interface SponsorRepo {
  createCard(row: CardRow): Promise<void>;
  getCard(id: string): Promise<CardRow | null>;
  /** 論理削除済みを除く。更新日時の新しい順。 */
  listCards(orgId: common.OrgId): Promise<CardRow[]>;
  /** 楽観ロック: version が expectedVersion のときだけ更新し true。 */
  updateCard(next: CardRow, expectedVersion: number): Promise<boolean>;
}

/** 写真の置き場。本番は R2 (r2ImageStore)、テストは fake。 */
export interface SponsorImageStore {
  put(key: string, bytes: ArrayBuffer, contentType: string): Promise<void>;
  /** 無ければ null。contentType は保存時のもの (取れなければ null)。 */
  get(key: string): Promise<{ body: ArrayBuffer; contentType: string | null } | null>;
  delete(key: string): Promise<void>;
}

/** 名刺写真の R2 キー。 */
export const cardImageKey = (cardId: string): string => `sponsor/cards/${cardId}`;

export function r2ImageStore(bucket: Pick<R2Bucket, "put" | "get" | "delete">): SponsorImageStore {
  return {
    async put(key, bytes, contentType) {
      await bucket.put(key, bytes, { httpMetadata: { contentType } });
    },
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return { body: await obj.arrayBuffer(), contentType: obj.httpMetadata?.contentType ?? null };
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}

const byUpdatedDesc = (a: CardRow, b: CardRow): number =>
  a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? 1 : -1;

export class InMemorySponsorRepo implements SponsorRepo {
  private cards = new Map<string, CardRow>();

  async createCard(row: CardRow): Promise<void> {
    this.cards.set(row.id, { ...row });
  }
  async getCard(id: string): Promise<CardRow | null> {
    const r = this.cards.get(id);
    return r ? { ...r } : null;
  }
  async listCards(orgId: common.OrgId): Promise<CardRow[]> {
    return [...this.cards.values()]
      .filter((c) => c.orgId === orgId && c.archivedAt === null)
      .sort(byUpdatedDesc)
      .map((c) => ({ ...c }));
  }
  async updateCard(next: CardRow, expectedVersion: number): Promise<boolean> {
    const cur = this.cards.get(next.id);
    if (!cur || cur.version !== expectedVersion) return false;
    this.cards.set(next.id, { ...next });
    return true;
  }
}

interface CardDbRow {
  id: string;
  org_id: string;
  company_name: string | null;
  person_name: string | null;
  department: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  note: string | null;
  image_content_type: string | null;
  version: number;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

function toCardRow(r: CardDbRow): CardRow {
  return {
    id: r.id,
    orgId: r.org_id,
    companyName: r.company_name,
    personName: r.person_name,
    department: r.department,
    title: r.title,
    email: r.email,
    phone: r.phone,
    note: r.note,
    imageContentType: r.image_content_type,
    version: r.version,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  };
}

export function createD1SponsorRepo(db: DbClient): SponsorRepo {
  return {
    async createCard(c) {
      await db.run(
        `INSERT INTO member_sponsor_cards (id, org_id, company_name, person_name, department, title, email, phone, note,
           image_content_type, version, created_by, created_by_name, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.id, c.orgId, c.companyName, c.personName, c.department, c.title, c.email, c.phone, c.note,
        c.imageContentType, c.version, c.createdBy, c.createdByName, c.createdAt, c.updatedAt, c.archivedAt,
      );
    },
    async getCard(id) {
      const r = await db.first<CardDbRow>(`SELECT * FROM member_sponsor_cards WHERE id = ?`, id);
      return r ? toCardRow(r) : null;
    },
    async listCards(orgId) {
      const rows = await db.all<CardDbRow>(
        `SELECT * FROM member_sponsor_cards WHERE org_id = ? AND archived_at IS NULL ORDER BY updated_at DESC, id DESC`,
        orgId,
      );
      return rows.map(toCardRow);
    },
    async updateCard(c, expectedVersion) {
      const res = await db.run(
        `UPDATE member_sponsor_cards SET company_name = ?, person_name = ?, department = ?, title = ?, email = ?, phone = ?,
           note = ?, image_content_type = ?, version = ?, updated_at = ?, archived_at = ?
         WHERE id = ? AND version = ?`,
        c.companyName, c.personName, c.department, c.title, c.email, c.phone,
        c.note, c.imageContentType, c.version, c.updatedAt, c.archivedAt,
        c.id, expectedVersion,
      );
      return res.meta.changes > 0;
    },
  };
}
