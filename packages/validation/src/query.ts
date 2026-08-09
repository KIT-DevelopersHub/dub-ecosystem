// Pagination / query-string validation for the common.CursorQuery contract (D3:
// opaque cursor, offset paging forbidden, limit default 50 / max 200).
import { errors, type FieldError } from "@dub/errors";
import type { common } from "@dub/types";
import { isFiniteNumber, isString } from "./primitives";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/**
 * Validate an already-parsed CursorQuery-shaped object (limit is number|undefined,
 * cursor is string|undefined). Returns a normalized CursorQuery with `limit`
 * defaulted to 50. Throws VALIDATION_FAILED on a bad shape.
 */
export function assertPaginatedQuery(input: unknown): common.CursorQuery {
  const fe: FieldError[] = [];
  const src: Record<string, unknown> =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
    throw errors.validationFailed([{ field: "(root)", reason: "invalid_type" }]);
  }

  const out: common.CursorQuery = {};

  const cursor = src.cursor;
  if (cursor !== undefined) {
    if (!isString(cursor)) fe.push({ field: "cursor", reason: "invalid_type" });
    else if (cursor.length > 0) out.cursor = cursor;
  }

  const limit = src.limit;
  if (limit !== undefined) {
    if (!isFiniteNumber(limit) || !Number.isInteger(limit)) {
      fe.push({ field: "limit", reason: "invalid_type", message: "limit must be an integer" });
    } else if (limit < 1) {
      fe.push({ field: "limit", reason: "too_small", message: "limit must be >= 1" });
    } else if (limit > MAX_LIMIT) {
      fe.push({ field: "limit", reason: "too_large", message: `limit must be <= ${MAX_LIMIT}` });
    } else {
      out.limit = limit;
    }
  }

  if (fe.length > 0) throw errors.validationFailed(fe);
  if (out.limit === undefined) out.limit = DEFAULT_LIMIT;
  return out;
}

/**
 * Parse raw query-string params (all string|undefined, as Hono's c.req.query()
 * yields) into a normalized CursorQuery. Non-numeric / out-of-range `limit` throws
 * VALIDATION_FAILED; empty cursor is dropped; `limit` defaults to 50.
 */
export function parseCursorQuery(
  raw: Record<string, string | undefined>,
): common.CursorQuery {
  const fe: FieldError[] = [];
  const out: common.CursorQuery = {};

  const cursor = raw.cursor;
  if (cursor !== undefined && cursor !== "") out.cursor = cursor;

  const limitRaw = raw.limit;
  if (limitRaw !== undefined && limitRaw !== "") {
    const n = Number(limitRaw);
    if (!Number.isInteger(n)) {
      fe.push({ field: "limit", reason: "invalid_type", message: "limit must be an integer" });
    } else if (n < 1) {
      fe.push({ field: "limit", reason: "too_small", message: "limit must be >= 1" });
    } else if (n > MAX_LIMIT) {
      fe.push({ field: "limit", reason: "too_large", message: `limit must be <= ${MAX_LIMIT}` });
    } else {
      out.limit = n;
    }
  }

  if (fe.length > 0) throw errors.validationFailed(fe);
  if (out.limit === undefined) out.limit = DEFAULT_LIMIT;
  return out;
}
