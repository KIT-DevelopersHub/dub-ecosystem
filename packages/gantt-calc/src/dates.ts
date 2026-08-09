// Day-space helpers. All schedule math is done in integer "days since UTC epoch"
// then mapped back to ISO8601 UTC midnight — keeps CPM deterministic (D2, テーマ3).
import { DubError, CommonErrorCodes } from "@dub/errors";
import type { common } from "@dub/types";

const MS_PER_DAY = 86_400_000;

/** Whole UTC days since epoch for an ISO8601 timestamp (time-of-day truncated). */
export function dayOf(iso: common.ISODateTime, field = "date"): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new DubError(CommonErrorCodes.VALIDATION_FAILED, `Invalid ISO8601 date: ${iso}`, {
      status: 400,
      details: [{ field, reason: "invalid_date" }],
    });
  }
  return Math.floor(ms / MS_PER_DAY);
}

/** Inverse of dayOf: a day index -> ISO8601 UTC midnight. */
export function isoAtDay(day: number): common.ISODateTime {
  return new Date(day * MS_PER_DAY).toISOString();
}
