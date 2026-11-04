// sponsor — スポンサーアプリ (スポンサーチーム向け) の wire 契約。
// フェーズ1 = 名刺: カメラで撮った名刺の写真と連絡先を登録し、権限のあるメンバー全員で共有する。
// 実装は member-service の /members/sponsor/* (D1 `member` namespace + R2 の写真)。
import type { ISODateTime, UserId } from "./common";

/** 写真として受け付ける形式 (端末側で JPEG に縮小してから送る)。 */
export const CARD_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type CardImageType = (typeof CARD_IMAGE_TYPES)[number];

/** 写真 1 枚の上限 (端末で縮小した後のサイズ)。 */
export const CARD_IMAGE_MAX_BYTES = 3 * 1024 * 1024;

/** テキスト項目の最大長 (メモ以外)。 */
export const CARD_FIELD_MAX = 200;
export const CARD_NOTE_MAX = 2000;

export function isCardImageType(v: unknown): v is CardImageType {
  return typeof v === "string" && (CARD_IMAGE_TYPES as readonly string[]).includes(v);
}

/** 名刺 1 枚。写真だけでも登録できるよう、テキスト項目はすべて任意。 */
export interface BusinessCard {
  id: string;
  companyName: string | null;
  personName: string | null;
  department: string | null;
  /** 役職。 */
  title: string | null;
  email: string | null;
  phone: string | null;
  /** 受け取った場面や共有したいこと (例: 〇〇展示会で名刺交換・協賛に前向き)。 */
  note: string | null;
  /** 写真があるか。写真本体は GET /members/sponsor/cards/:id/image。 */
  hasImage: boolean;
  version: number;
  /** 登録したメンバー (identity user id) と、その時点の表示名。 */
  createdBy: UserId;
  createdByName: string | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface ListCardsResponse {
  cards: BusinessCard[];
}

export interface CardFields {
  companyName?: string | null;
  personName?: string | null;
  department?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  note?: string | null;
}

export type CreateCardRequest = CardFields;

export interface UpdateCardRequest extends CardFields {
  expectedVersion: number;
}

/** 一覧・検索で使う表示名 (会社名 / 氏名が無い名刺は「名刺（未入力）」)。 */
export function cardDisplayName(c: Pick<BusinessCard, "companyName" | "personName">): string {
  const parts = [c.companyName, c.personName].filter((s): s is string => !!s && s.trim() !== "");
  return parts.length > 0 ? parts.join(" / ") : "名刺（未入力）";
}
