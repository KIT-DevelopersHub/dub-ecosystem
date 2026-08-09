import { describe, it, expect } from "vitest";
import {
  errorCodeToUserMessage,
  shouldResetTurnstile,
  isRetryable,
  NETWORK_ERROR,
} from "../src/lib/error-messages";

describe("errorCodeToUserMessage", () => {
  it("maps each design §6 code to distinct copy", () => {
    for (const code of ["VALIDATION_FAILED", "GATEWAY_TURNSTILE_FAILED", "RATE_LIMITED", NETWORK_ERROR]) {
      expect(errorCodeToUserMessage(code)).toBeTruthy();
    }
    expect(errorCodeToUserMessage("VALIDATION_FAILED")).not.toEqual(
      errorCodeToUserMessage("RATE_LIMITED"),
    );
  });

  it("falls back for unknown / INTERNAL codes", () => {
    expect(errorCodeToUserMessage("INTERNAL")).toBeTruthy();
    expect(errorCodeToUserMessage("SOME_UNSEEN_CODE")).toBeTruthy();
  });

  it("treats FORBIDDEN and GATEWAY_TURNSTILE_FAILED as turnstile failures", () => {
    expect(errorCodeToUserMessage("FORBIDDEN")).toEqual(
      errorCodeToUserMessage("GATEWAY_TURNSTILE_FAILED"),
    );
  });
});

describe("shouldResetTurnstile", () => {
  it("resets only on turnstile/forbidden", () => {
    expect(shouldResetTurnstile("GATEWAY_TURNSTILE_FAILED")).toBe(true);
    expect(shouldResetTurnstile("FORBIDDEN")).toBe(true);
    expect(shouldResetTurnstile("RATE_LIMITED")).toBe(false);
    expect(shouldResetTurnstile("VALIDATION_FAILED")).toBe(false);
  });
});

describe("isRetryable", () => {
  it("allows retry for transient failures, not validation", () => {
    expect(isRetryable(NETWORK_ERROR)).toBe(true);
    expect(isRetryable("RATE_LIMITED")).toBe(true);
    expect(isRetryable("INTERNAL")).toBe(true);
    expect(isRetryable("VALIDATION_FAILED")).toBe(false);
  });
});
