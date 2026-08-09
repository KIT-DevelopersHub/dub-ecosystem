import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../src/lib/relative-time";

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-08-09T12:00:00Z");
  it("formats recent times", () => {
    expect(formatRelativeTime("2026-08-09T11:59:50Z", now)).toBe("now");
    expect(formatRelativeTime("2026-08-09T11:55:00Z", now)).toBe("5m");
    expect(formatRelativeTime("2026-08-09T09:00:00Z", now)).toBe("3h");
    expect(formatRelativeTime("2026-08-07T12:00:00Z", now)).toBe("2d");
  });
  it("falls back to a date for old items and empty for invalid input", () => {
    expect(formatRelativeTime("2026-07-01T12:00:00Z", now)).toBe("2026-07-01");
    expect(formatRelativeTime("not-a-date", now)).toBe("");
  });
});
