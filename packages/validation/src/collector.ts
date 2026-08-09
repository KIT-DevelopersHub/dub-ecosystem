// FieldCollector — accumulate every FieldError for one request, then throw once.
//
// The services all hand-rolled the same `const fe: FieldError[] = []; ... ; if
// (fe.length) throw errors.validationFailed(fe)` shape (see task-service/validate.ts,
// audit-log/validation.ts). This is that shape, factored out, so a body validator
// reports ALL problems in a single VALIDATION_FAILED response instead of failing
// on the first — which is what FE form rendering needs.
import { errors, type DubError, type FieldError } from "@dub/errors";
import type { ValidationReason } from "./reason";
import {
  isBoolean,
  isFiniteNumber,
  isInteger,
  isNonEmptyString,
  isString,
} from "./primitives";

export class FieldCollector {
  private readonly fields: FieldError[] = [];

  /** Push a raw field error. `message` is the human-readable optional hint. */
  add(field: string, reason: ValidationReason, message?: string): this {
    const fe: FieldError = { field, reason };
    if (message !== undefined) fe.message = message;
    this.fields.push(fe);
    return this;
  }

  get hasErrors(): boolean {
    return this.fields.length > 0;
  }

  /** Snapshot of accumulated errors (copy — callers cannot mutate internal state). */
  errors(): FieldError[] {
    return this.fields.slice();
  }

  /** Throw VALIDATION_FAILED with every accumulated FieldError; no-op if clean. */
  throwIfInvalid(message = "Validation failed"): void {
    if (this.fields.length > 0) throw errors.validationFailed(this.fields.slice(), message);
  }

  // ---- required-field checks (absence -> "required") ----

  requireString(field: string, v: unknown, opts?: { min?: number; max?: number }): void {
    if (v === undefined || v === null) {
      this.add(field, "required");
      return;
    }
    if (!isString(v)) {
      this.add(field, "invalid_type", `${field} must be a string`);
      return;
    }
    this.lengthBounds(field, v, opts);
  }

  requireNonEmptyString(field: string, v: unknown, max?: number): void {
    if (v === undefined || v === null) {
      this.add(field, "required");
      return;
    }
    if (!isString(v)) {
      this.add(field, "invalid_type", `${field} must be a string`);
      return;
    }
    if (v.length === 0) {
      this.add(field, "empty", `${field} must not be empty`);
      return;
    }
    if (max !== undefined && v.length > max) {
      this.add(field, "too_long", `${field} must be at most ${max} chars`);
    }
  }

  // ---- optional-field checks (undefined -> skip; null handled per-caller) ----

  optionalString(field: string, v: unknown, opts?: { min?: number; max?: number }): void {
    if (v === undefined) return;
    if (!isString(v)) {
      this.add(field, "invalid_type", `${field} must be a string`);
      return;
    }
    this.lengthBounds(field, v, opts);
  }

  optionalBoolean(field: string, v: unknown): void {
    if (v === undefined) return;
    if (!isBoolean(v)) this.add(field, "invalid_type", `${field} must be a boolean`);
  }

  /** Optional bounded integer. Emits too_small / too_large with the actual bound. */
  optionalInteger(field: string, v: unknown, opts?: { min?: number; max?: number }): void {
    if (v === undefined) return;
    if (!isInteger(v)) {
      this.add(field, "invalid_type", `${field} must be an integer`);
      return;
    }
    if (opts?.min !== undefined && v < opts.min) {
      this.add(field, "too_small", `${field} must be >= ${opts.min}`);
    }
    if (opts?.max !== undefined && v > opts.max) {
      this.add(field, "too_large", `${field} must be <= ${opts.max}`);
    }
  }

  /** Membership test against a closed enum set; undefined skips (use requireEnum to forbid). */
  optionalEnum(field: string, v: unknown, allowed: ReadonlySet<string>): void {
    if (v === undefined) return;
    if (!isString(v) || !allowed.has(v)) this.add(field, "invalid_enum");
  }

  requireEnum(field: string, v: unknown, allowed: ReadonlySet<string>): void {
    if (v === undefined || v === null) {
      this.add(field, "required");
      return;
    }
    if (!isString(v) || !allowed.has(v)) this.add(field, "invalid_enum");
  }

  private lengthBounds(field: string, v: string, opts?: { min?: number; max?: number }): void {
    if (opts?.min !== undefined && v.length < opts.min) {
      this.add(field, "too_short", `${field} must be at least ${opts.min} chars`);
    }
    if (opts?.max !== undefined && v.length > opts.max) {
      this.add(field, "too_long", `${field} must be at most ${opts.max} chars`);
    }
  }
}

/** Throw VALIDATION_FAILED for a single-field failure (root-shape rejection etc.). */
export function invalidField(field: string, reason: ValidationReason, message?: string): DubError {
  const fe: FieldError = { field, reason };
  if (message !== undefined) fe.message = message;
  return errors.validationFailed([fe]);
}

// Re-export the primitives most collector callers also reach for, so a service can
// `import { FieldCollector, isFiniteNumber } from "@dub/validation"` from one place.
export { isFiniteNumber, isNonEmptyString };
