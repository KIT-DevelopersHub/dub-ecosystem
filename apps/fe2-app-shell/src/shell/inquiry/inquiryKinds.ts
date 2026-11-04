// 問い合わせ種別 (⚙ → 問い合わせ) and the fields each one asks for. The backend stores
// `kind` + one free-text `message`; the structured fields are folded into that message
// by composeInquiryMessage so the admin notification/email reads them as-is.
import type { notification } from "@dub/types";

export type InquiryKind = notification.InquiryKind;
export type FeedbackCategory = notification.FeedbackCategory;

export interface InquiryField {
  key: string;
  label: string;
  input: "text" | "number" | "textarea";
  required?: boolean;
  placeholder?: string;
  /** Appended to the value in the composed message (e.g. "枚"). */
  unit?: string;
}

export interface InquiryKindSpec {
  kind: InquiryKind;
  label: string;
  lead: string;
  fields: InquiryField[];
}

const MESSAGE_FIELD: InquiryField = { key: "message", label: "内容", input: "textarea", required: true };

/** Display order of the 種別 choices. */
export const INQUIRY_KIND_SPECS: InquiryKindSpec[] = [
  {
    kind: "feedback",
    label: "フィードバック",
    lead: "このアプリで気づいたこと（直してほしい所・要望など）をお知らせください。",
    fields: [{ ...MESSAGE_FIELD, placeholder: "例：イベント一覧の並び順を新しい順にしてほしい" }],
  },
  {
    kind: "business_card",
    label: "名刺が切れた",
    lead: "名刺の追加をお願いできます。必要な枚数を教えてください。",
    fields: [
      { key: "count", label: "希望枚数", input: "number", required: true, placeholder: "例：50", unit: "枚" },
      { key: "note", label: "補足", input: "textarea", placeholder: "例：来週のイベントまでに欲しい" },
    ],
  },
  {
    kind: "invite_friend",
    label: "友達を誘いたい",
    lead: "DevelopersHub に誘いたい友達を教えてください。運営から案内します。",
    fields: [
      { key: "name", label: "友達の名前", input: "text", required: true, placeholder: "例：山田 太郎" },
      { key: "contact", label: "連絡先", input: "text", placeholder: "メールアドレスや SNS など" },
      { key: "note", label: "補足", input: "textarea", placeholder: "例：同じ学科の友達で、ハッカソンに興味がある" },
    ],
  },
  {
    kind: "interview",
    label: "面談を希望する",
    lead: "運営との面談を申し込めます。都合のよい日時の候補を書いてください。",
    fields: [
      { key: "slots", label: "希望日時の候補", input: "textarea", required: true, placeholder: "例：11/10(月) 18時以降、11/12(水) 終日" },
      { key: "topic", label: "相談したい内容", input: "textarea", placeholder: "例：今後の関わり方について" },
    ],
  },
  {
    kind: "other",
    label: "その他",
    lead: "上のどれにも当てはまらないご連絡はこちらからどうぞ。",
    fields: [MESSAGE_FIELD],
  },
];

export function specOf(kind: InquiryKind): InquiryKindSpec {
  return INQUIRY_KIND_SPECS.find((s) => s.kind === kind) ?? INQUIRY_KIND_SPECS[0]!;
}

/** First required field left blank (or a non-positive number), or null when the form is complete. */
export function firstMissingField(spec: InquiryKindSpec, values: Record<string, string>): { key: string; error: string } | null {
  for (const f of spec.fields) {
    const v = (values[f.key] ?? "").trim();
    if (f.required && v.length === 0) return { key: f.key, error: `${f.label}を入力してください。` };
    if (f.input === "number" && v.length > 0 && !(Number.isInteger(Number(v)) && Number(v) > 0)) {
      return { key: f.key, error: `${f.label}は 1 以上の整数で入力してください。` };
    }
  }
  return null;
}

/**
 * Fold the kind's fields into the single message the backend stores. A kind whose only
 * field is 内容 sends it verbatim; otherwise single-line fields become "ラベル: 値" lines
 * and textareas "ラベル:\n本文" blocks. Blank optional fields are omitted.
 */
export function composeInquiryMessage(spec: InquiryKindSpec, values: Record<string, string>): string {
  if (spec.fields.length === 1 && spec.fields[0]!.key === "message") return (values.message ?? "").trim();
  const lines: string[] = [];
  const blocks: string[] = [];
  for (const f of spec.fields) {
    const v = (values[f.key] ?? "").trim();
    if (!v) continue;
    if (f.input === "textarea") blocks.push(`${f.label}:\n${v}`);
    else lines.push(`${f.label}: ${v}${f.unit ?? ""}`);
  }
  return [lines.join("\n"), ...blocks].filter(Boolean).join("\n\n");
}
