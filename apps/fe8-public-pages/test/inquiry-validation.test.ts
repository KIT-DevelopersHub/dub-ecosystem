import { describe, it, expect } from "vitest";
import {
  validateInquiry,
  toInquiryRequest,
  MESSAGE_MIN,
  MESSAGE_MAX,
  type InquiryFormValues,
} from "../src/lib/inquiry-validation";

function base(overrides: Partial<InquiryFormValues> = {}): InquiryFormValues {
  return {
    kind: "general",
    name: "山田 太郎",
    email: "taro@example.com",
    message: "お問い合わせの本文です。",
    turnstileToken: "tok_abc",
    ...overrides,
  };
}

describe("validateInquiry", () => {
  it("passes a well-formed submission", () => {
    expect(validateInquiry(base())).toEqual([]);
  });

  it("rejects a missing/invalid kind", () => {
    const errs = validateInquiry(base({ kind: "" }));
    expect(errs.some((e) => e.field === "kind" && e.reason === "required")).toBe(true);
    const bad = validateInquiry(base({ kind: "banana" }));
    expect(bad.some((e) => e.field === "kind")).toBe(true);
  });

  it("requires name and email and message and turnstile", () => {
    const errs = validateInquiry({ kind: "sponsor", name: " ", email: "", message: "", turnstileToken: "" });
    const fields = errs.map((e) => e.field).sort();
    expect(fields).toEqual(["email", "message", "name", "turnstileToken"]);
  });

  it("rejects malformed emails", () => {
    for (const email of ["nope", "a@b", "a b@x.com", "@x.com", "x@.com"]) {
      const errs = validateInquiry(base({ email }));
      expect(errs.some((e) => e.field === "email" && e.reason === "invalid")).toBe(true);
    }
  });

  it("enforces message length bounds", () => {
    const tooShort = validateInquiry(base({ message: "x".repeat(MESSAGE_MIN - 1) }));
    expect(tooShort.some((e) => e.field === "message" && e.reason === "too_short")).toBe(true);
    const tooLong = validateInquiry(base({ message: "x".repeat(MESSAGE_MAX + 1) }));
    expect(tooLong.some((e) => e.field === "message" && e.reason === "too_long")).toBe(true);
  });
});

describe("toInquiryRequest", () => {
  it("produces a contract-exact body (trimmed, no extra keys)", () => {
    const req = toInquiryRequest(base({ name: "  A  ", email: "  a@b.co  " }));
    expect(req).toEqual({
      kind: "general",
      name: "A",
      email: "a@b.co",
      message: "お問い合わせの本文です。",
      turnstileToken: "tok_abc",
    });
    expect(Object.keys(req).sort()).toEqual(["email", "kind", "message", "name", "turnstileToken"]);
  });

  it("throws on an invalid kind (guards the type boundary)", () => {
    expect(() => toInquiryRequest(base({ kind: "x" }))).toThrow();
  });
});
