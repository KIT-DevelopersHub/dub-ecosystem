import { describe, it, expect } from "vitest";
import { toSnapshotRows } from "../src/collect";
import { MASTER } from "../src/limits";

describe("toSnapshotRows", () => {
  it("produces one row per master metric", () => {
    const rows = toSnapshotRows({});
    expect(rows).toHaveLength(MASTER.length);
  });

  it("maps a measured value to used/pct/status", () => {
    const rows = toSnapshotRows({ workers_requests_day: 70_000 });
    const w = rows.find((r) => r.metric_key === "workers_requests_day")!;
    expect(w.used).toBe(70_000);
    expect(w.pct).toBe(70);
    expect(w.status).toBe("warn");
    expect(w.overflow_behavior).toBe("halt");
  });

  it("marks metrics with no measured value as unknown (graceful)", () => {
    const rows = toSnapshotRows({ workers_requests_day: 10 });
    const d1 = rows.find((r) => r.metric_key === "d1_rows_read_day")!;
    expect(d1.used).toBeNull();
    expect(d1.pct).toBeNull();
    expect(d1.status).toBe("unknown");
  });

  it("flags a critical breach at >=90%", () => {
    const rows = toSnapshotRows({ resend_emails_day: 95 }); // limit 100
    const r = rows.find((r) => r.metric_key === "resend_emails_day")!;
    expect(r.pct).toBe(95);
    expect(r.status).toBe("critical");
  });
});
