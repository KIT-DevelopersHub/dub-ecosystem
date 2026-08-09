// Canonical machine-readable FieldError.reason vocabulary.
//
// Every reason a @dub/validation check emits comes from here so that FE form-error
// rendering (which switches on `reason`) sees one stable, closed set instead of the
// ad-hoc strings the services hand-rolled independently ("invalid_enum" here,
// "invalid_range" there). Adding a reason is a deliberate, reviewable change.

export const ValidationReasons = {
  REQUIRED: "required",
  INVALID_TYPE: "invalid_type",
  INVALID_ENUM: "invalid_enum",
  INVALID_FORMAT: "invalid_format",
  INVALID_DATETIME: "invalid_datetime",
  TOO_SHORT: "too_short",
  TOO_LONG: "too_long",
  TOO_SMALL: "too_small",
  TOO_LARGE: "too_large",
  EMPTY: "empty",
} as const;

export type ValidationReason = (typeof ValidationReasons)[keyof typeof ValidationReasons];
