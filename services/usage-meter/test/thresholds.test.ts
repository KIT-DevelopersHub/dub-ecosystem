import { describe, it, expect } from "vitest";
import { computePct, statusForPct, worstStatus, WARN_PCT, CRITICAL_PCT } from "../src/thresholds";

describe("computePct", () => {
  it("computes a 1-decimal percentage", () => {
    expect(computePct(12345, 100000)).toBe(12.3);
    expect(computePct(50, 100)).toBe(50);
    expect(computePct(90000, 100000)).toBe(90);
  });
  it("returns null for unknown used or non-positive limit", () => {
    expect(computePct(null, 100)).toBeNull();
    expect(computePct(10, 0)).toBeNull();
    expect(computePct(10, -5)).toBeNull();
    expect(computePct(Number.NaN, 100)).toBeNull();
  });
});

describe("statusForPct", () => {
  it("maps to ok/warn/critical/unknown around the thresholds", () => {
    expect(statusForPct(0)).toBe("ok");
    expect(statusForPct(WARN_PCT - 0.1)).toBe("ok");
    expect(statusForPct(WARN_PCT)).toBe("warn");
    expect(statusForPct(CRITICAL_PCT - 0.1)).toBe("warn");
    expect(statusForPct(CRITICAL_PCT)).toBe("critical");
    expect(statusForPct(150)).toBe("critical");
    expect(statusForPct(null)).toBe("unknown");
  });
});

describe("worstStatus", () => {
  it("critical > warn > unknown > ok, empty -> ok", () => {
    expect(worstStatus([])).toBe("ok");
    expect(worstStatus(["ok", "ok"])).toBe("ok");
    expect(worstStatus(["ok", "unknown"])).toBe("unknown");
    expect(worstStatus(["unknown", "warn"])).toBe("warn");
    expect(worstStatus(["warn", "critical", "ok"])).toBe("critical");
  });
});
