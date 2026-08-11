import { describe, it, expect } from "vitest";
import { MASTER, MASTER_BY_KEY, resetAt } from "../src/limits";

describe("free-tier master", () => {
  it("has unique metric keys and positive limits", () => {
    const keys = MASTER.map((m) => m.metricKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const m of MASTER) expect(m.limit).toBeGreaterThan(0);
  });

  it("covers the required Cloudflare + Resend metrics", () => {
    for (const k of [
      "workers_requests_day",
      "d1_rows_read_day",
      "d1_rows_written_day",
      "d1_storage",
      "kv_reads_day",
      "kv_writes_day",
      "r2_storage",
      "r2_class_a_month",
      "r2_class_b_month",
      "do_requests_day",
      "resend_emails_day",
      "resend_emails_month",
    ]) {
      expect(MASTER_BY_KEY.has(k), `missing ${k}`).toBe(true);
    }
  });

  it("every metric's overflowBehavior is a valid halt|bill label (all halt on Free)", () => {
    for (const m of MASTER) {
      expect(["halt", "bill"]).toContain(m.overflowBehavior);
      // Free plan: nothing auto-bills.
      expect(m.overflowBehavior).toBe("halt");
    }
  });

  it("carries the documented published free-tier numbers", () => {
    expect(MASTER_BY_KEY.get("workers_requests_day")!.limit).toBe(100_000);
    expect(MASTER_BY_KEY.get("d1_rows_read_day")!.limit).toBe(5_000_000);
    expect(MASTER_BY_KEY.get("d1_rows_written_day")!.limit).toBe(100_000);
    expect(MASTER_BY_KEY.get("kv_writes_day")!.limit).toBe(1_000);
    expect(MASTER_BY_KEY.get("r2_class_a_month")!.limit).toBe(1_000_000);
    expect(MASTER_BY_KEY.get("r2_class_b_month")!.limit).toBe(10_000_000);
    expect(MASTER_BY_KEY.get("resend_emails_day")!.limit).toBe(100);
    expect(MASTER_BY_KEY.get("resend_emails_month")!.limit).toBe(3_000);
  });
});

describe("resetAt", () => {
  const now = new Date("2026-08-12T09:30:00.000Z");
  it("daily -> next UTC midnight", () => {
    expect(resetAt("daily", now)).toBe("2026-08-13T00:00:00.000Z");
  });
  it("monthly -> first of next UTC month", () => {
    expect(resetAt("monthly", now)).toBe("2026-09-01T00:00:00.000Z");
  });
  it("none -> null (cumulative)", () => {
    expect(resetAt("none", now)).toBeNull();
  });
});
