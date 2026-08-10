import { describe, it, expect } from "vitest";
import {
  MAIL_RATE_LIMITED,
  DEFAULT_RATE_LIMIT_COOLDOWN_SEC,
  parseRetryAfter,
  parseCooldownSec,
  rateLimitError,
  deriveRateLimitStatus,
} from "../src/rate-limit";

const NOW = Date.parse("2026-08-10T12:00:00.000Z");
const res = (headers: Record<string, string> = {}): Response => new Response("{}", { status: 429, headers });

describe("parseRetryAfter", () => {
  it("reads a delta-seconds header", () => {
    expect(parseRetryAfter(res({ "retry-after": "45" }), NOW)).toBe(45);
  });
  it("reads an HTTP-date header as remaining whole seconds", () => {
    const at = new Date(NOW + 90_000).toUTCString();
    expect(parseRetryAfter(res({ "retry-after": at }), NOW)).toBe(90);
  });
  it("clamps a past HTTP-date to 0 and never goes negative", () => {
    const past = new Date(NOW - 60_000).toUTCString();
    expect(parseRetryAfter(res({ "retry-after": past }), NOW)).toBe(0);
  });
  it("returns undefined when absent or garbled", () => {
    expect(parseRetryAfter(res(), NOW)).toBeUndefined();
    expect(parseRetryAfter(res({ "retry-after": "soon" }), NOW)).toBeUndefined();
  });
  it("clamps an absurd delta to one day", () => {
    expect(parseRetryAfter(res({ "retry-after": "999999999" }), NOW)).toBe(24 * 60 * 60);
  });
});

describe("rateLimitError", () => {
  it("is MAIL_RATE_LIMITED / 429 / retryable and carries retryAfterSec", () => {
    const e = rateLimitError("Resend", res({ "retry-after": "30" }), "daily quota", NOW);
    expect(e.code).toBe(MAIL_RATE_LIMITED);
    expect(e.status).toBe(429);
    expect(e.retryable).toBe(true);
    expect(e.message).toContain("Resend");
    expect(e.message).toContain("daily quota");
    expect(e.details).toEqual({ retryAfterSec: 30 });
  });
  it("omits details when the provider gave no Retry-After", () => {
    expect(rateLimitError("SES", res(), null, NOW).details).toBeUndefined();
  });
});

describe("parseCooldownSec", () => {
  it("defaults and clamps", () => {
    expect(parseCooldownSec(undefined)).toBe(DEFAULT_RATE_LIMIT_COOLDOWN_SEC);
    expect(parseCooldownSec("")).toBe(DEFAULT_RATE_LIMIT_COOLDOWN_SEC);
    expect(parseCooldownSec("120")).toBe(120);
    expect(parseCooldownSec("0")).toBe(DEFAULT_RATE_LIMIT_COOLDOWN_SEC); // below min
    expect(parseCooldownSec("999999999")).toBe(DEFAULT_RATE_LIMIT_COOLDOWN_SEC); // above max
    expect(parseCooldownSec("1.5")).toBe(DEFAULT_RATE_LIMIT_COOLDOWN_SEC); // non-integer
  });
});

describe("deriveRateLimitStatus", () => {
  it("is active when the latest failure is a recent 429", () => {
    const since = new Date(NOW - 20_000).toISOString();
    const s = deriveRateLimitStatus({ error_code: MAIL_RATE_LIMITED, updated_at: since }, NOW, 60);
    expect(s.active).toBe(true);
    expect(s.code).toBe(MAIL_RATE_LIMITED);
    expect(s.since).toBe(since);
    expect(s.recoversAt).toBe(new Date(Date.parse(since) + 60_000).toISOString());
    expect(s.cooldownSec).toBe(60);
  });
  it("is clear once the cooldown window has elapsed", () => {
    const since = new Date(NOW - 120_000).toISOString();
    expect(deriveRateLimitStatus({ error_code: MAIL_RATE_LIMITED, updated_at: since }, NOW, 60).active).toBe(false);
  });
  it("is clear when the latest failure is a different code", () => {
    const since = new Date(NOW - 5_000).toISOString();
    expect(deriveRateLimitStatus({ error_code: "MAIL_PROVIDER_UNAVAILABLE", updated_at: since }, NOW, 60).active).toBe(false);
  });
  it("is clear when there is no failure at all", () => {
    const s = deriveRateLimitStatus(null, NOW, 60);
    expect(s).toEqual({ active: false, cooldownSec: 60 });
  });
});
