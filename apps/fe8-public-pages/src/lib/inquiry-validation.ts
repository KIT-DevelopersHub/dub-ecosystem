// Client-side validation for the inquiry form (design §6/§7 test-point 4).
// Mirrors gateway server-side validation shape: failures are @dub/errors FieldError[]
// (field/reason/message) so the same rendering path handles client + server errors.

import type { FieldError } from "@dub/errors/wire";
import type { PublicInquiryRequest, PublicInquiryKind } from "@dub/types";

export const INQUIRY_KINDS: readonly PublicInquiryKind[] = ["general", "sponsor", "press"];

export const MESSAGE_MIN = 10;
export const MESSAGE_MAX = 4000;
export const NAME_MAX = 120;
export const EMAIL_MAX = 254;

// Pragmatic RFC-5322-subset: single @, no spaces, dotted domain.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Raw form values before contract coercion (all strings, kind may be empty). */
export interface InquiryFormValues {
  kind: string;
  name: string;
  email: string;
  message: string;
  turnstileToken: string;
}

function isKind(value: string): value is PublicInquiryKind {
  return (INQUIRY_KINDS as readonly string[]).includes(value);
}

/**
 * Validate raw form values. Returns FieldError[] (empty === valid).
 * turnstileToken is validated for presence only — the real check is gateway-side.
 */
export function validateInquiry(values: InquiryFormValues): FieldError[] {
  const errors: FieldError[] = [];

  if (!values.kind || !isKind(values.kind)) {
    errors.push({ field: "kind", reason: "required", message: "お問い合わせ種別を選択してください。" });
  }

  const name = values.name.trim();
  if (!name) {
    errors.push({ field: "name", reason: "required", message: "お名前を入力してください。" });
  } else if (name.length > NAME_MAX) {
    errors.push({ field: "name", reason: "too_long", message: `お名前は${NAME_MAX}文字以内で入力してください。` });
  }

  const email = values.email.trim();
  if (!email) {
    errors.push({ field: "email", reason: "required", message: "メールアドレスを入力してください。" });
  } else if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
    errors.push({ field: "email", reason: "invalid", message: "メールアドレスの形式が正しくありません。" });
  }

  const message = values.message.trim();
  if (!message) {
    errors.push({ field: "message", reason: "required", message: "お問い合わせ内容を入力してください。" });
  } else if (message.length < MESSAGE_MIN) {
    errors.push({ field: "message", reason: "too_short", message: `お問い合わせ内容は${MESSAGE_MIN}文字以上で入力してください。` });
  } else if (message.length > MESSAGE_MAX) {
    errors.push({ field: "message", reason: "too_long", message: `お問い合わせ内容は${MESSAGE_MAX}文字以内で入力してください。` });
  }

  if (!values.turnstileToken) {
    errors.push({ field: "turnstileToken", reason: "required", message: "認証を完了してください。" });
  }

  return errors;
}

/** Coerce validated form values into the contract-exact request body. */
export function toInquiryRequest(values: InquiryFormValues): PublicInquiryRequest {
  if (!isKind(values.kind)) {
    throw new Error(`invalid inquiry kind: ${values.kind}`);
  }
  return {
    kind: values.kind,
    name: values.name.trim(),
    email: values.email.trim(),
    message: values.message.trim(),
    turnstileToken: values.turnstileToken,
  };
}
