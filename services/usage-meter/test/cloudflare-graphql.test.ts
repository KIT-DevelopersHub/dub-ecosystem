import { describe, it, expect } from "vitest";
import { buildUsageQuery, extractMetrics, fetchCloudflareUsage } from "../src/cloudflare-graphql";

const NOW = new Date("2026-08-12T09:30:00.000Z");

describe("buildUsageQuery", () => {
  it("targets the account and the required datasets with a UTC window", () => {
    const { query, variables } = buildUsageQuery("acct_123", NOW);
    expect(query).toContain("workersInvocationsAdaptive");
    expect(query).toContain("d1AnalyticsAdaptiveGroups");
    expect(query).toContain("kvOperationsAdaptiveGroups");
    expect(query).toContain("r2OperationsAdaptiveGroups");
    expect(query).toContain("r2StorageAdaptiveGroups");
    expect(query).toContain("durableObjectsInvocationsAdaptiveGroups");
    expect(variables).toMatchObject({
      tag: "acct_123",
      dayStart: "2026-08-12T00:00:00.000Z",
      today: "2026-08-12",
      monthStart: "2026-08-01",
    });
  });
});

describe("extractMetrics", () => {
  it("parses a full response into metric keys", () => {
    const body = {
      data: {
        viewer: {
          accounts: [
            {
              workersInvocationsAdaptive: [{ sum: { requests: 1200 } }],
              d1AnalyticsAdaptiveGroups: [{ sum: { readQueries: 40000, writeQueries: 800 } }],
              kvOperationsAdaptiveGroups: [
                { dimensions: { actionType: "read" }, sum: { requests: 500 } },
                { dimensions: { actionType: "write" }, sum: { requests: 30 } },
              ],
              r2OperationsAdaptiveGroups: [
                { dimensions: { actionType: "PutObject" }, sum: { requests: 100 } },
                { dimensions: { actionType: "GetObject" }, sum: { requests: 900 } },
              ],
              r2StorageAdaptiveGroups: [{ max: { payloadSize: 2048 } }],
              durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 77 } }],
            },
          ],
        },
      },
    };
    expect(extractMetrics(body)).toEqual({
      workers_requests_day: 1200,
      d1_rows_read_day: 40000,
      d1_rows_written_day: 800,
      kv_reads_day: 500,
      kv_writes_day: 30,
      r2_class_a_month: 100,
      r2_class_b_month: 900,
      r2_storage: 2048,
      do_requests_day: 77,
    });
  });

  it("omits datasets that are missing/misshaped (they become unknown downstream)", () => {
    const body = { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 5 } }] }] } } };
    expect(extractMetrics(body)).toEqual({ workers_requests_day: 5 });
  });

  it("returns {} for a totally unexpected body (never throws)", () => {
    expect(extractMetrics(null)).toEqual({});
    expect(extractMetrics({ errors: [{ message: "bad arg" }] })).toEqual({});
  });
});

describe("fetchCloudflareUsage (graceful)", () => {
  it("returns {} on a non-2xx without throwing", async () => {
    const res = await fetchCloudflareUsage(
      { token: "t", accountId: "a", fetchImpl: async () => new Response("nope", { status: 403 }) },
      NOW,
    );
    expect(res).toEqual({});
  });

  it("returns {} when fetch rejects (network error)", async () => {
    const res = await fetchCloudflareUsage(
      {
        token: "t",
        accountId: "a",
        fetchImpl: async () => {
          throw new Error("boom");
        },
      },
      NOW,
    );
    expect(res).toEqual({});
  });

  it("extracts metrics from a 200 body", async () => {
    const body = { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 42 } }] }] } } };
    const res = await fetchCloudflareUsage(
      { token: "t", accountId: "a", fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }) },
      NOW,
    );
    expect(res).toEqual({ workers_requests_day: 42 });
  });
});
