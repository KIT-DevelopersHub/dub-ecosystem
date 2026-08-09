// @dub/validation — contract-derived runtime validation for inter-service I/O.
//
// Purpose: the services were each hand-rolling the same FieldError[] accumulation
// and the same enum membership sets (task-service/validate.ts,
// audit-log/validation.ts, ...). This package factors that into ONE reusable layer
// whose allowed values are derived from the @dub/types contracts, and whose failure
// path is the canonical @dub/errors VALIDATION_FAILED DubError carrying FieldError[]
// details (the shape FE form rendering depends on). Zero external deps: hand-rolled,
// no zod — matching the ecosystem's dependency-light stance.

export { ValidationReasons, type ValidationReason } from "./reason";

export {
  ISO_DATETIME_RE,
  ISO_DATE_RE,
  EMAIL_RE,
  isPlainObject,
  isString,
  isNonEmptyString,
  isBoolean,
  isFiniteNumber,
  isInteger,
  isStringArray,
  isISODateTime,
  isISODate,
  isEmail,
} from "./primitives";

export { FieldCollector, invalidField } from "./collector";

export {
  isTaskStatus,
  isTaskPriority,
  isTaskOrigin,
  isPermissionKey,
  isUserStatus,
  isMailProvider,
  isTaskStatusTransitionAllowed,
  ENUM_SETS,
} from "./guards";

export {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  assertPaginatedQuery,
  parseCursorQuery,
} from "./query";

export { validateCreateTaskRequest, validateUpdateTaskRequest } from "./task";

export { validateSendMailRequest } from "./mail";
