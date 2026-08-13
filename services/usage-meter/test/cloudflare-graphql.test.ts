import { describe, it, expect } from "vitest";
import { buildUsageQuery, extractMetrics, fetchCloudflareUsage } from "../src/cloudflare-graphql";

const NOW = new Date("2026-08-12T09:30:00.000Z");

describe("buildUsageQuery", () => {
  it("targets the account and the required datasets with a UTC window", () => {
    const { query, variables } = buildUsageQuery("acct_123", NOW);
    expect(query).toContain("workersInvocationsAdaptive");
    expect(query).toContain("d1AnalyticsAdaptiveGroups");
    expect(query).toContain("d1StorageAdaptiveGroups"); // d1_storage now queried (was never)
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

  it("does NOT order by date (the orderBy on r2Storage null-nuked the whole response)", () => {
    const { query } = buildUsageQuery("acct_123", NOW);
    expect(query).not.toContain("orderBy");
    expect(query).not.toContain("date_DESC");
  });

  it("uses the metered D1 row dimensions rowsRead/rowsWritten (not read/writeQueries)", () => {
    const { query } = buildUsageQuery("acct_123", NOW);
    expect(query).toContain("rowsRead");
    expect(query).toContain("rowsWritten");
    expect(query).not.toContain("readQueries");
    expect(query).not.toContain("writeQueries");
  });

  it("groups D1 storage by databaseId (account-wide total spans multiple DBs)", () => {
    const { query } = buildUsageQuery("acct_123", NOW);
    expect(query).toContain("databaseSizeBytes");
    expect(query).toContain("databaseId");
  });
});

describe("extractMetrics", () => {
  it("parses a full (real-shaped) response into every metric key", () => {
    // Fixture mirrors the values probed live against the prod account.
    const body = {
      data: {
        viewer: {
          accounts: [
            {
              workersInvocationsAdaptive: [{ sum: { requests: 3368 } }],
              d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 23373, rowsWritten: 4270 } }],
              d1StorageAdaptiveGroups: [
                { max: { databaseSizeBytes: 1355776 }, dimensions: { databaseId: "db_a" } },
                { max: { databaseSizeBytes: 110592 }, dimensions: { databaseId: "db_b" } },
              ],
              kvOperationsAdaptiveGroups: [
                { dimensions: { actionType: "read" }, sum: { requests: 1530 } },
                { dimensions: { actionType: "write" }, sum: { requests: 40 } },
                { dimensions: { actionType: "delete" }, sum: { requests: 10 } },
              ],
              r2OperationsAdaptiveGroups: [
                { dimensions: { actionType: "HeadBucket" }, sum: { requests: 12 } }, // Class B via default
              ],
              r2StorageAdaptiveGroups: [{ max: { payloadSize: 0, metadataSize: 0 } }],
              durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 210 } }],
            },
          ],
        },
      },
    };
    expect(extractMetrics(body)).toEqual({
      workers_requests_day: 3368,
      d1_rows_read_day: 23373,
      d1_rows_written_day: 4270,
      d1_storage: 1466368, // SUM of the per-databaseId max sizes (1355776 + 110592)
      kv_reads_day: 1530, // read
      kv_writes_day: 50, // write + delete
      r2_class_a_month: 0,
      r2_class_b_month: 12, // HeadBucket -> Class B
      r2_storage: 0,
      do_requests_day: 210,
    });
  });

  it("sums D1 storage across databaseId groups (account-wide free-tier ceiling)", () => {
    const body = {
      data: {
        viewer: {
          accounts: [
            {
              d1StorageAdaptiveGroups: [
                { max: { databaseSizeBytes: 1000 }, dimensions: { databaseId: "a" } },
                { max: { databaseSizeBytes: 2500 }, dimensions: { databaseId: "b" } },
                { max: { databaseSizeBytes: 500 }, dimensions: { databaseId: "c" } },
              ],
            },
          ],
        },
      },
    };
    expect(extractMetrics(body)).toEqual({ d1_storage: 4000 });
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
