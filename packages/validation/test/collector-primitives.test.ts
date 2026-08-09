import { describe, it, expect } from "vitest";
import { DubError, isDubError, CommonErrorCodes, type FieldError } from "@dub/errors";
import {
  FieldCollector,
  invalidField,
  isISODateTime,
  isISODate,
  isEmail,
  isFiniteNumber,
  isStringArray,
} from "../src/index";

function catchDub(fn: () => void): DubError {
  try {
    fn();
  } catch (e) {
    if (isDubError(e)) return e;
    throw e;
  }
  throw new Error("expected a DubError to be thrown");
}

describe("primitives", () => {
  it("isISODateTime requires shape AND parseability", () => {
    expect(isISODateTime("2026-08-09T05:00:00Z")).toBe(true);
    expect(isISODateTime("2026-08-09T05:00:00.123+09:00")).toBe(true);
    expect(isISODateTime("2026-08-09")).toBe(false); // date only
    expect(isISODateTime("2026-13-40T00:00:00Z")).toBe(false); // shape ok, unparseable
    expect(isISODateTime(0)).toBe(false);
  });

  it("isISODate", () => {
    expect(isISODate("2026-08-09")).toBe(true);
    expect(isISODate("2026-08-09T00:00:00Z")).toBe(false);
  });

  it("isEmail is pragmatic", () => {
    expect(isEmail("a@b.co")).toBe(true);
    expect(isEmail("no-at")).toBe(false);
    expect(isEmail("a@b")).toBe(false);
    expect(isEmail(42)).toBe(false);
  });

  it("isFiniteNumber rejects NaN/Infinity", () => {
    expect(isFiniteNumber(1.5)).toBe(true);
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
  });

  it("isStringArray", () => {
    expect(isStringArray(["a", "b"])).toBe(true);
    expect(isStringArray([])).toBe(true);
    expect(isStringArray(["a", 1])).toBe(false);
    expect(isStringArray("a")).toBe(false);
  });
});

describe("FieldCollector", () => {
  it("accumulates all errors and throws one VALIDATION_FAILED with FieldError[] details", () => {
    const c = new FieldCollector();
    c.requireNonEmptyString("a", "");
    c.requireString("b", 5);
    c.optionalEnum("c", "x", new Set(["y", "z"]));
    expect(c.hasErrors).toBe(true);
    expect(c.errors()).toHaveLength(3);

    const err = catchDub(() => c.throwIfInvalid());
    expect(err.code).toBe(CommonErrorCodes.VALIDATION_FAILED);
    expect(err.status).toBe(400);
    const details = err.details as FieldError[];
    expect(details.map((d) => d.field)).toEqual(["a", "b", "c"]);
    expect(details[0]?.reason).toBe("empty");
    expect(details[1]?.reason).toBe("invalid_type");
    expect(details[2]?.reason).toBe("invalid_enum");
  });

  it("throwIfInvalid is a no-op when clean", () => {
    const c = new FieldCollector();
    c.optionalString("x", undefined);
    c.requireString("y", "ok");
    expect(c.hasErrors).toBe(false);
    expect(() => c.throwIfInvalid()).not.toThrow();
  });

  it("errors() returns a copy (caller cannot mutate internal state)", () => {
    const c = new FieldCollector();
    c.add("a", "required");
    c.errors().push({ field: "injected", reason: "required" });
    expect(c.errors()).toHaveLength(1);
  });

  it("optionalInteger bounds", () => {
    const c = new FieldCollector();
    c.optionalInteger("n", 5, { min: 1, max: 3 });
    c.optionalInteger("m", 1.5, { min: 0 });
    c.optionalInteger("skip", undefined);
    const d = c.errors();
    expect(d.map((x) => [x.field, x.reason])).toEqual([
      ["n", "too_large"],
      ["m", "invalid_type"],
    ]);
  });

  it("invalidField builds a single-field VALIDATION_FAILED", () => {
    const err = invalidField("(root)", "invalid_type", "body must be an object");
    expect(err.code).toBe(CommonErrorCodes.VALIDATION_FAILED);
    const details = err.details as FieldError[];
    expect(details).toEqual([
      { field: "(root)", reason: "invalid_type", message: "body must be an object" },
    ]);
  });
});
