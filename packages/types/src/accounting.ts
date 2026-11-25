// 会計: 団体の発行者情報 (member-service /members/accounting/issuer)。領収書 (lp-tickets) はここを読む。
// 入力の検査と正規化はここが SoT (サーバの保存と画面のフォームが同じ関数を使う)。
import type { ISODateTime, UserId } from "./common";

export const ISSUER_NAME_MAX = 100;
export const ISSUER_OFFICE_MAX = 100;
export const ISSUER_ADDRESS_MAX = 200;
export const ISSUER_EMAIL_MAX = 254;
export const ISSUER_URL_MAX = 300;

/** 選べる消費税率 (%)。チケットは標準税率。軽減税率 8% は食品などの販売用。 */
export const TAX_RATES = [10, 8] as const;
export type TaxRatePercent = (typeof TAX_RATES)[number];
export const DEFAULT_TAX_RATE: TaxRatePercent = 10;

/** 保存する発行者情報。任意項目は null = 未設定。 */
export interface IssuerSettings {
  /** 法人名 (例: 一般社団法人 Developers Hub)。必須。 */
  name: string;
  /** 事務局名 (領収書の発行者欄に出す表示名)。null = 各アプリの既定 (例: 「<イベント名> 事務局」)。 */
  officeName: string | null;
  /** 郵便番号 (NNN-NNNN)。 */
  postalCode: string | null;
  /** 住所 (都道府県から)。 */
  address: string | null;
  phone: string | null;
  email: string | null;
  /** https:// で始まる URL。 */
  url: string | null;
  /** 適格請求書発行事業者の登録番号 (T + 13 桁)。null = 登録なし (領収書に消費税額の内訳を出さない)。 */
  invoiceRegistrationNo: string | null;
  taxRatePercent: TaxRatePercent;
}

export interface AccountingIssuer extends IssuerSettings {
  version: number;
  updatedBy: UserId;
  updatedByName: string | null;
  updatedAt: ISODateTime;
}

/** GET /members/accounting/issuer と GET /members/internal/accounting/issuer。issuer null = まだ一度も保存していない。 */
export interface GetIssuerResponse {
  issuer: AccountingIssuer | null;
}

/** PUT /members/accounting/issuer。新規は expectedVersion 0 (楽観ロック)。 */
export interface PutIssuerRequest extends IssuerSettings {
  expectedVersion: number;
}

export type IssuerField = keyof IssuerSettings;
export type IssuerFieldError = { field: IssuerField; reason: "required" | "too_long" | "invalid" | "check_digit" };

const FULLWIDTH_DIGIT = /[０-９]/g;
const halfWidth = (s: string): string => s.replace(FULLWIDTH_DIGIT, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** 登録番号の正規化: 全角数字・小文字の t・空白とハイフンを許して「T + 13 桁」にそろえる。形が違えば null。 */
export function normalizeInvoiceRegistrationNo(raw: string): string | null {
  const s = halfWidth(raw.normalize("NFKC")).replace(/[\s-]/g, "").toUpperCase();
  return /^T\d{13}$/.test(s) ? s : null;
}

/**
 * 登録番号の確認用の数字 (先頭の 1 桁) が合っているか。法人番号と同じ式 (国税庁「法人番号の指定等に関する省令」):
 * 残り 12 桁を右から P1..P12 とし、Q = 奇数番目 1・偶数番目 2 で 9 − (Σ P×Q mod 9)。
 */
export function invoiceRegistrationNoCheckDigitOk(normalized: string): boolean {
  const m = /^T(\d)(\d{12})$/.exec(normalized);
  if (!m) return false;
  const base = m[2]!;
  let sum = 0;
  for (let n = 1; n <= 12; n++) sum += Number(base[12 - n]) * (n % 2 === 1 ? 1 : 2);
  return Number(m[1]) === 9 - (sum % 9);
}

/** 郵便番号の正規化: 7 桁を NNN-NNNN に。形が違えば null。 */
export function normalizePostalCode(raw: string): string | null {
  const s = halfWidth(raw.normalize("NFKC")).replace(/[\s〒]/g, "");
  const m = /^(\d{3})-?(\d{4})$/.exec(s);
  return m ? `${m[1]}-${m[2]}` : null;
}

const PHONE_RE = /^\+?[0-9][0-9-]{8,18}[0-9]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s]+\.[^\s]+$/;

/** 領収書などに出す住所 1 行 (〒NNN-NNNN 住所)。どちらも無ければ null。 */
export function formatIssuerAddress(s: Pick<IssuerSettings, "postalCode" | "address">): string | null {
  const parts = [s.postalCode ? `〒${s.postalCode}` : null, s.address].filter((p): p is string => !!p);
  return parts.length ? parts.join(" ") : null;
}

/** 税込金額のうち消費税 (内税・端数切り捨て)。 */
export const taxIncluded = (amountJpy: number, ratePercent: number): number =>
  Math.floor((amountJpy * ratePercent) / (100 + ratePercent));

/**
 * 入力の検査と正規化。前後の空白は落とし、任意項目の空欄は null。
 * 画面 (保存前のフィールド表示) とサーバ (400 の根拠) が同じ結果を出す。
 */
export function parseIssuerInput(raw: unknown): { ok: true; value: IssuerSettings } | { ok: false; errors: IssuerFieldError[] } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const errors: IssuerFieldError[] = [];
  const text = (field: IssuerField, max: number, required = false): string | null => {
    const v = b[field];
    if (v !== undefined && v !== null && typeof v !== "string") {
      errors.push({ field, reason: "invalid" });
      return null;
    }
    const s = (v ?? "").trim();
    if (!s) {
      if (required) errors.push({ field, reason: "required" });
      return null;
    }
    if (CONTROL.test(s)) errors.push({ field, reason: "invalid" });
    else if (s.length > max) errors.push({ field, reason: "too_long" });
    return s;
  };
  const shaped = (field: IssuerField, max: number, fn: (s: string) => string | null): string | null => {
    const s = text(field, max);
    if (s === null) return null;
    const out = fn(s);
    if (out === null && !errors.some((e) => e.field === field)) errors.push({ field, reason: "invalid" });
    return out;
  };

  const name = text("name", ISSUER_NAME_MAX, true);
  const officeName = text("officeName", ISSUER_OFFICE_MAX);
  const postalCode = shaped("postalCode", 10, normalizePostalCode);
  const address = text("address", ISSUER_ADDRESS_MAX);
  const phone = shaped("phone", 20, (s) => {
    const p = halfWidth(s.normalize("NFKC")).replace(/\s/g, "");
    return PHONE_RE.test(p) ? p : null;
  });
  const email = shaped("email", ISSUER_EMAIL_MAX, (s) => (EMAIL_RE.test(s) ? s : null));
  const url = shaped("url", ISSUER_URL_MAX, (s) => (URL_RE.test(s) ? s : null));
  let invoiceRegistrationNo = shaped("invoiceRegistrationNo", 20, normalizeInvoiceRegistrationNo);
  if (invoiceRegistrationNo !== null && !invoiceRegistrationNoCheckDigitOk(invoiceRegistrationNo)) {
    errors.push({ field: "invoiceRegistrationNo", reason: "check_digit" });
    invoiceRegistrationNo = null;
  }
  const rate = b.taxRatePercent ?? DEFAULT_TAX_RATE;
  if (!TAX_RATES.includes(rate as TaxRatePercent)) errors.push({ field: "taxRatePercent", reason: "invalid" });

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { name: name!, officeName, postalCode, address, phone, email, url, invoiceRegistrationNo, taxRatePercent: rate as TaxRatePercent },
  };
}

/** フィールドのエラー文言 (画面用)。 */
export function issuerErrorMessage(e: IssuerFieldError): string {
  if (e.reason === "required") return "入力してください";
  if (e.reason === "too_long") return "長すぎます";
  if (e.reason === "check_digit") return "登録番号が正しくありません（T のすぐ後の確認用の数字が合いません）";
  switch (e.field) {
    case "invoiceRegistrationNo": return "T と 13 桁の数字で入力してください（例: T7000012050002）";
    case "postalCode": return "7 桁の数字で入力してください（例: 920-0000）";
    case "phone": return "数字とハイフンで入力してください（例: 076-000-0000）";
    case "email": return "メールアドレスの形で入力してください";
    case "url": return "https:// から入力してください";
    default: return "使えない文字が含まれています";
  }
}
