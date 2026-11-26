// PII redaction applied to EVERY string that leaves a collector (and again to every
// line a provider returns). Defence in depth: collectors already pick allowlisted
// fields only (never spread a raw record), this catches what slips through inside
// free text (a pinned chat message quoting an address, a mail subject with a phone).
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// JP / intl phone shapes: 0X-XXXX-XXXX, 090XXXXXXXX, +81 90 ... (not dates: needs a
// leading 0 or +81 and no digit right before it).
const PHONE = /(?<![\dA-Za-z])(?:\+81[-\s]?\d{1,4}|0\d{1,4})[-\s(]?\d{1,4}[-\s)]?\d{3,4}(?!\d)/g;
// Long bare digit runs (学籍番号・会員番号・カード番号の断片). Counts in digests stay short.
const LONG_DIGITS = /(?<![\dA-Za-z_])\d{7,}(?![\dA-Za-z_])/g;

export const REDACTED = "［伏せ字］";

export function redactPii(text: string): string {
  return text.replace(EMAIL, REDACTED).replace(PHONE, REDACTED).replace(LONG_DIGITS, REDACTED);
}

/** Bound + redact one free-text field. Non-strings become "". */
export function safeText(v: unknown, cap = 200): string {
  if (typeof v !== "string") return "";
  const one = v.replace(/\s+/g, " ").trim();
  return redactPii(one.length > cap ? `${one.slice(0, cap)}…` : one);
}
