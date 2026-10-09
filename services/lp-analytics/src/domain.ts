// Pure rules shared by the service and its tests: slug normalization (same rules as fe2
// lpLinks.ts so client-side preview == server result), JST day keys, range validation.
import { errors } from "@dub/errors";

export const LP_TRACKING_PARAM = "utm_source";
export const LP_SLUG_MAX = 32;
export const LP_NAME_MAX = 40;
/** Source key for a pageview that carried no utm_source. */
export const DIRECT_SOURCE = "direct";
/** 1 リクエストで読める最大日数。無料枠の D1 読み取りを守る（画面は最大 90 日）。 */
export const MAX_RANGE_DAYS = 92;

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 小文字化 + 前後の空白と "-" の除去（fe2 normalizeSlug と同一）。 */
export function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^-+|-+$/g, "")
    .slice(0, LP_SLUG_MAX);
}

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && SLUG_RE.test(slug);
}

/** utm_source as received from the wild → stored source key. Anything unusable is "direct"
 *  only when absent; a present-but-odd value is kept (normalized) so it is still visible. */
export function sourceFromParam(raw: string | null): string {
  if (raw === null) return DIRECT_SOURCE;
  const s = normalizeSlug(raw).replace(/[^a-z0-9_-]/g, "");
  return s.length > 0 ? s : DIRECT_SOURCE;
}

export function buildTrackingUrl(baseUrl: string, slug: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set(LP_TRACKING_PARAM, slug);
  return url.toString();
}

/** ISO timestamp → JST calendar day (YYYY-MM-DD). */
export function dayJst(iso: string): string {
  return new Date(new Date(iso).getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function isRealDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

/** Validates the inclusive day range every read takes. Throws 400 on a bad range. */
export function parseRange(from: string | undefined, to: string | undefined): { from: string; to: string } {
  const f = from ?? "";
  const t = to ?? "";
  const bad: { field: string; reason: string }[] = [];
  if (!isRealDay(f)) bad.push({ field: "from", reason: "invalid" });
  if (!isRealDay(t)) bad.push({ field: "to", reason: "invalid" });
  if (bad.length === 0 && f > t) bad.push({ field: "from", reason: "after_to" });
  if (bad.length === 0 && daysBetween(f, t) > MAX_RANGE_DAYS) bad.push({ field: "to", reason: "range_too_long" });
  if (bad.length > 0) throw errors.validationFailed(bad);
  return { from: f, to: t };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Every day in [from, to] — byDay emits zero rows too (a gap would make the chart lie). */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export const DEVICE_LABELS: Record<string, string> = { mobile: "スマホ", desktop: "PC", bot: "bot", unknown: "不明" };
export const DIRECT_LABEL = "直接アクセス";
