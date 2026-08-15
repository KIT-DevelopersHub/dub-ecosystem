import { describe, it, expect } from "vitest";
import { makeD1 } from "./d1";
import { readLatestSnapshot, upsertSnapshot, usageDb } from "../src/snapshot-repo";
import type { SnapshotRow } from "../src/types";

// A minimal snapshot row factory. `used`/`pct` NULL ⇔ status "unknown" (mirrors the collector).
function row(
  provider: SnapshotRow["provider"],
  metricKey: string,
  used: number | null,
  status: SnapshotRow["status"],
): SnapshotRow {
  return {
    provider,
    metric_key: metricKey,
    label: metricKey,
    used,
    limit_value: 1000,
    pct: used === null ? null : (used / 1000) * 100,
    unit: "req/day",
    overflow_behavior: provider === "resend" ? "halt" : "bill",
    status,
  };
}

describe("readLatestSnapshot — resilient last-known read", () => {
  it("surfaces a metric's last KNOWN value when the latest day collected it as unknown", async () => {
    const { d1 } = makeD1();
    const db = usageDb(d1);

    // 08-13: everything collected fine.
    await upsertSnapshot(
      db,
      [row("cloudflare", "workers_requests_day", 3427, "ok"), row("resend", "resend_emails_day", 20, "ok")],
      new Date("2026-08-13T20:47:49.792Z"),
    );
    // 08-14 (latest): the Cloudflare fetch blipped → CF row written as unknown; Resend fine.
    await upsertSnapshot(
      db,
      [row("cloudflare", "workers_requests_day", null, "unknown"), row("resend", "resend_emails_day", 11, "ok")],
      new Date("2026-08-14T20:47:48.869Z"),
    );

    const rows = await readLatestSnapshot(db);
    const byKey = new Map(rows.map((r) => [r.metric_key, r]));

    // CF carried forward from 08-13 (NOT blanked to "取得不可"); Resend is the fresh 08-14 value.
    expect(byKey.get("workers_requests_day")).toMatchObject({ used: 3427, status: "ok" });
    expect(byKey.get("resend_emails_day")).toMatchObject({ used: 11, status: "ok" });
    // No unknown row ever leaks into the read — those metrics are simply absent.
    expect(rows.every((r) => r.status !== "unknown")).toBe(true);
  });

  it("omits a metric whose last known value is older than the lookback window (→ unknown downstream)", async () => {
    const { d1 } = makeD1();
    const db = usageDb(d1);

    // A known value 10 days before the latest capture day — beyond the 7-day lookback.
    await upsertSnapshot(db, [row("cloudflare", "workers_requests_day", 999, "ok")], new Date("2026-08-04T00:00:00Z"));
    // Latest day has it as unknown.
    await upsertSnapshot(
      db,
      [row("cloudflare", "workers_requests_day", null, "unknown"), row("resend", "resend_emails_day", 5, "ok")],
      new Date("2026-08-14T00:00:00Z"),
    );

    const rows = await readLatestSnapshot(db);
    const keys = rows.map((r) => r.metric_key);
    expect(keys).not.toContain("workers_requests_day"); // too stale → dropped, renders unknown
    expect(keys).toContain("resend_emails_day");
  });

  it("returns [] when nothing usable was ever collected", async () => {
    const { d1 } = makeD1();
    const db = usageDb(d1);
    await upsertSnapshot(db, [row("cloudflare", "workers_requests_day", null, "unknown")], new Date("2026-08-14T00:00:00Z"));
    expect(await readLatestSnapshot(db)).toEqual([]);
  });
});
