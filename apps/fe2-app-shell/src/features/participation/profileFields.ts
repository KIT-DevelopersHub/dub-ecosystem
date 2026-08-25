// SINGLE SOURCE OF TRUTH for the self-editable 参加届 (participation) profile fields.
//
// Every field key here is a real key of the canonical `member.SubmitParticipationRequest`
// (the member-service submit contract), enforced at compile time — so the self-edit surface
// (アカウント設定) can never drift from what the public 参加届 form submits. Labels/options for
// the closed unions (学年/希望活動) come from the canonical `contracts.ts` maps, so nothing is
// re-defined here. The public ParticipationForm collects the same set (name split / kana /
// romaji / emails / phone / grade / department / activity / note).
import { GRADES, GRADE_LABEL, DESIRED_ACTIVITIES, ACTIVITY_LABEL, type SubmitParticipationRequest } from "./contracts.ts";
import type { SelfParticipation } from "../../lib/api-client.tsx";

export type { SelfParticipation };

// Compile-time tie: each descriptor key must be a real key of SubmitParticipationRequest
// AND of SelfParticipation (so the wire contract and the self-edit model stay in lockstep).
export type SelfParticipationKey = keyof SelfParticipation & keyof SubmitParticipationRequest;

export type ParticipationFieldKind = "text" | "email" | "textarea" | "select";

export interface ParticipationFieldDescriptor {
  key: SelfParticipationKey;
  label: string;
  kind: ParticipationFieldKind;
  /** Render two-up on a row with the next `half` field (name/kana/romaji pairs). */
  half?: boolean;
  help?: string;
  placeholder?: string;
  /** Present for `select` fields — closed-union options from the canonical maps. */
  options?: { value: string; label: string }[];
}

const GRADE_OPTIONS = GRADES.map((g) => ({ value: g, label: GRADE_LABEL[g] }));
const ACTIVITY_OPTIONS = DESIRED_ACTIVITIES.map((a) => ({ value: a, label: ACTIVITY_LABEL[a] }));

/** The ordered field set shown in アカウント設定 → 参加情報. */
export const PARTICIPATION_PROFILE_FIELDS: ParticipationFieldDescriptor[] = [
  { key: "lastName", label: "氏名（苗字）", kind: "text", half: true, placeholder: "山田" },
  { key: "firstName", label: "氏名（名前）", kind: "text", half: true, placeholder: "太郎" },
  { key: "lastNameKana", label: "ふりがな（せい）", kind: "text", half: true, placeholder: "やまだ" },
  { key: "firstNameKana", label: "ふりがな（めい）", kind: "text", half: true, placeholder: "たろう" },
  { key: "lastNameRomaji", label: "ローマ字（姓）", kind: "text", half: true, help: "メール発行に使用", placeholder: "Yamada" },
  { key: "firstNameRomaji", label: "ローマ字（名）", kind: "text", half: true, placeholder: "Taro" },
  { key: "schoolEmail", label: "学校のメールアドレス", kind: "email", half: true, placeholder: "you@school.ac.jp" },
  { key: "gmail", label: "Gmail アドレス", kind: "email", half: true, placeholder: "you@gmail.com" },
  { key: "phone", label: "電話番号", kind: "text", half: true, help: "緊急連絡用（任意）", placeholder: "090-1234-5678" },
  { key: "grade", label: "学年", kind: "select", half: true, options: GRADE_OPTIONS },
  { key: "department", label: "学科", kind: "text", half: true, placeholder: "情報工学科" },
  { key: "desiredActivity", label: "希望する活動", kind: "select", half: true, options: ACTIVITY_OPTIONS },
  { key: "note", label: "その他", kind: "textarea", help: "連絡事項など（任意）" },
];

/** An empty 参加届 profile (all fields null). */
export function emptySelfParticipation(): SelfParticipation {
  return {
    lastName: null,
    firstName: null,
    lastNameKana: null,
    firstNameKana: null,
    lastNameRomaji: null,
    firstNameRomaji: null,
    schoolEmail: null,
    gmail: null,
    phone: null,
    grade: null,
    department: null,
    desiredActivity: null,
    note: null,
  };
}
