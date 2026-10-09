import { describe, it, expect } from "vitest";
import { buildQuery, createCfSiteTrafficSource, referrerLabel, type SiteTrafficData } from "../src/site-traffic";
import type { LpSiteTraffic } from "../src/types";
import { get, makeApp } from "./harness";

const ROWS: SiteTrafficData = {
  days: [
    { date: "2026-10-01", pageViews: 82, visits: 45 },
    { date: "2026-10-02", pageViews: 29, visits: 18 },
  ],
  referrers: [
    { date: "2026-10-01", host: "hokuriku-it-conf.com", pageViews: 37, visits: 0 },
    { date: "2026-10-01", host: "m.facebook.com", pageViews: 12, visits: 12 },
    { date: "2026-10-01", host: "www.facebook.com", pageViews: 2, visits: 2 },
    { date: "2026-10-01", host: "", pageViews: 9, visits: 9 },
    { date: "2026-10-02", host: "t.co", pageViews: 5, visits: 4 },
  ],
};

describe("GET /lp/site-traffic", () => {
  it("aggregates per JST day (zero-filled) and merges referrer hosts by label", async () => {
    let asked: readonly string[] = [];
    const { app } = await makeApp("memory", "view", 5000, {
      fetchDays: async (days) => ((asked = days), ROWS),
    });
    const res = await app.fetch(get("/lp/site-traffic?from=2026-09-30&to=2026-10-02"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as LpSiteTraffic;
    expect(asked).toEqual(["2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(body.configured).toBe(true);
    expect(body.totals).toEqual({ pageViews: 111, visits: 63 });
    expect(body.byDay).toEqual([
      { date: "2026-09-30", pageViews: 0, visits: 0 },
      { date: "2026-10-01", pageViews: 82, visits: 45 },
      { date: "2026-10-02", pageViews: 29, visits: 18 },
    ]);
    expect(body.byReferrer.map((r) => [r.label, r.pageViews])).toEqual([
      ["サイト内の移動", 37],
      ["Facebook", 14],
      ["直接アクセス", 9],
      ["X (Twitter)", 5],
    ]);
  });

  it("reports configured=false (not an error) when Cloudflare is not set up", async () => {
    const { app } = await makeApp("memory", "view");
    const body = (await (await app.fetch(get("/lp/site-traffic?from=2026-10-01&to=2026-10-02"))).json()) as LpSiteTraffic;
    expect(body.configured).toBe(false);
    expect(body.byDay).toHaveLength(2);
  });

  it("is behind the LP管理 view gate", async () => {
    const { app } = await makeApp("memory", "none", 5000, { fetchDays: async () => ROWS });
    expect((await app.fetch(get("/lp/site-traffic?from=2026-10-01&to=2026-10-02"))).status).toBe(403);
  });

  it("returns 503 when Cloudflare fails", async () => {
    const { app } = await makeApp("memory", "view", 5000, {
      fetchDays: async () => {
        throw new Error("boom");
      },
    });
    expect((await app.fetch(get("/lp/site-traffic?from=2026-10-01&to=2026-10-02"))).status).toBeGreaterThanOrEqual(500);
  });
});

describe("Cloudflare source", () => {
  it("queries one alias per JST day, chunked, and maps groups back to days", async () => {
    const bodies: { query: string; variables: Record<string, string> }[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, string> };
      bodies.push(body);
      const n = (body.query.match(/rumPageloadEventsAdaptiveGroups/g) ?? []).length / 2;
      const account: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        account[`t${i}`] = [{ count: 4, sum: { visits: 3 } }];
        account[`r${i}`] = [{ count: 3, sum: { visits: 2 }, dimensions: { refererHost: "t.co" } }];
      }
      return new Response(JSON.stringify({ data: { viewer: { accounts: [account] } }, errors: null }));
    }) as unknown as typeof fetch;
    const src = createCfSiteTrafficSource({ token: "t", accountId: "acc", siteTag: "site", fetch: fakeFetch });
    const days = Array.from({ length: 25 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
    const data = await src.fetchDays(days);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]!.variables).toEqual({ accountTag: "acc", siteTag: "site" });
    expect(data.days).toHaveLength(25);
    expect(data.days[24]).toEqual({ date: "2026-09-25", pageViews: 4, visits: 3 });
    expect(data.referrers[24]).toEqual({ date: "2026-09-25", host: "t.co", pageViews: 3, visits: 2 });
  });

  it("JST day boundaries are 15:00Z the previous UTC day", () => {
    const q = buildQuery(["2026-10-01"]);
    expect(q).toContain('datetime_geq: "2026-09-30T15:00:00Z"');
    expect(q).toContain('datetime_lt: "2026-10-01T15:00:00Z"');
  });

  it("surfaces GraphQL errors as upstream failures", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ data: null, errors: [{ message: "quota" }] }))) as unknown as typeof fetch;
    const src = createCfSiteTrafficSource({ token: "t", accountId: "a", siteTag: "s", fetch: fakeFetch });
    await expect(src.fetchDays(["2026-10-01"])).rejects.toMatchObject({ code: expect.any(String) });
  });
});

describe("referrerLabel", () => {
  it("names direct, in-site and known hosts; passes unknown hosts through", () => {
    expect(referrerLabel("", "hokuriku-it-conf.com")).toBe("直接アクセス");
    expect(referrerLabel("hokuriku-it-conf.com", "hokuriku-it-conf.com")).toBe("サイト内の移動");
    expect(referrerLabel("t.co", "hokuriku-it-conf.com")).toBe("X (Twitter)");
    expect(referrerLabel("example.org", "hokuriku-it-conf.com")).toBe("example.org");
  });
});
