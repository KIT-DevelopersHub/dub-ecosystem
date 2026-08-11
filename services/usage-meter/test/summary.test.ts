import { describe, it, expect } from "vitest";
import { buildSummary, breachedServices } from "../src/summary";
import { MASTER } from "../src/limits";
import type { SnapshotRow } from "../src/types";

const NOW = new Date("2026-08-12T09:30:00.000Z");

function row(metricKey: string, used: number, pct: number, status: SnapshotRow["status"]): SnapshotRow {
  return {
    provider: "cloudflare",
    metric_key: metricKey,
    label: "x",
    used,
    limit_value: 100,
    pct,
    unit: "u",
    overflow_behavior: "halt",
    status,
  };
}

describe("buildSummary", () => {
  it("returns the full master set as unknown when there are no snapshot rows", () => {
    const s = buildSummary([], NOW);
    expect(s.services).toHaveLength(MASTER.length);
    expect(s.services.every((x) => x.status === "unknown" && x.used === null && x.pct === null)).toBe(true);
    expect(s.worstStatus).toBe("unknown");
    expect(s.generatedAt).toBe(NOW.toISOString());
  });

  it("honors the frozen contract shape and computes resetsAt from the master cadence", () => {
    const s = buildSummary([row("workers_requests_day", 90, 90, "critical")], NOW);
    const w = s.services.find((x) => x.metricKey === "workers_requests_day")!;
    expect(w).toMatchObject({
      provider: "cloudflare",
      metricKey: "workers_requests_day",
      limit: 100_000, // from master, not the row's limit_value
      overflowBehavior: "halt",
      status: "critical",
      unit: "req/day",
    });
    expect(w.resetsAt).toBe("2026-08-13T00:00:00.000Z"); // daily
    // storage metric is cumulative -> null reset
    expect(s.services.find((x) => x.metricKey === "d1_storage")!.resetsAt).toBeNull();
    expect(s.worstStatus).toBe("critical");
  });
});

describe("breachedServices", () => {
  it("returns only warn/critical entries", () => {
    const s = buildSummary(
      [row("workers_requests_day", 72, 72, "warn"), row("resend_emails_day", 95, 95, "critical")],
      NOW,
    );
    const breaches = breachedServices(s).map((b) => b.metricKey);
    expect(breaches).toContain("workers_requests_day");
    expect(breaches).toContain("resend_emails_day");
    expect(breaches).not.toContain("d1_storage");
  });
});
