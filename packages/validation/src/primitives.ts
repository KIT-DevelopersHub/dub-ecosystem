// Pure, allocation-free type-narrowing predicates. No throwing, no @dub deps —
// the atoms every higher-level validator composes from. Kept separate so they can
// be reused by callers that only need a boolean, not a FieldError side effect.

/** ISO8601 UTC date-time, e.g. "2026-08-09T05:00:00Z" (fractional seconds + offset ok). */
export const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** ISO8601 calendar date, e.g. "2026-08-09". */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Pragmatic single-address email check (RFC-complete parsing is out of scope). */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function isString(v: unknown): v is string {
  return typeof v === "string";
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

/** Finite number only — rejects NaN / Infinity that `typeof x === "number"` admits. */
export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function isInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** true only for a real ISO8601 UTC date-time (regex shape AND a parseable instant). */
export function isISODateTime(v: unknown): v is string {
  return typeof v === "string" && ISO_DATETIME_RE.test(v) && !Number.isNaN(Date.parse(v));
}

export function isISODate(v: unknown): v is string {
  return typeof v === "string" && ISO_DATE_RE.test(v) && !Number.isNaN(Date.parse(v));
}

export function isEmail(v: unknown): v is string {
  return typeof v === "string" && v.length <= 320 && EMAIL_RE.test(v);
}
