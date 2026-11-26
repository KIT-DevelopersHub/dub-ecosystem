import { describe, it, expect } from "vitest";
import type { lpInsights } from "@dub/types";
import { get, makeApp, send, type RepoKind } from "./harness";

const RANGE = "from=2026-10-01&to=2026-10-07";
const INTERNAL = { "x-dub-internal": "1", "x-dub-user-id": "system:public-lp-visit" };

function event(body: Partial<lpInsights.LpInsightIngest>): Request {
  const base: lpInsights.LpInsightIngest = {
    path: "/",
    first: true,
    source: null,
    medium: null,
    campaign: null,
    referrerHost: null,
    device: "mobile",
    os: "ios",
    browser: "safari",
    country: "JP",
    region: "JP-17",
    engagedMs: 10_000,
    scroll: 50,
    sections: [],
    ctas: [],
    steps: [],
    vitals: null,
  };
  return send("POST", "/lp/internal/events", { ...base, ...body }, INTERNAL);
}

const read = async (res: Response): Promise<lpInsights.LpInsights> => (await res.json()) as lpInsights.LpInsights;

describe.each<RepoKind>(["memory", "d1"])("lp-analytics insights (%s repo)", (kind) => {
  it("aggregates sessions, pages, sources, sections, CTAs, scroll, funnel and vitals", async () => {
    const { app, clock } = await makeApp(kind);
    await app.fetch(send("POST", `/lp/links?${RANGE}`, { name: "Instagram 告知", slug: "instagram" }));

    clock.set("2026-10-05T01:00:00.000Z");
    // 訪問 A: Instagram から入って、トップ → チケット → 申し込み → 完了。
    expect(
      (
        await app.fetch(
          event({
            source: "Instagram",
            medium: "social",
            campaign: "early-bird",
            referrerHost: "l.instagram.com",
            browser: "instagram",
            scroll: 100,
            sections: ["join", "program"],
            ctas: ["tickets@join", "tickets@join"],
            vitals: { lcp: 1800, inp: 120, cls: 0.02 },
          }),
        )
      ).status,
    ).toBe(204);
    await app.fetch(event({ path: "/tickets", first: false, source: "instagram", steps: ["tickets", "checkout"], engagedMs: 30_000 }));
    await app.fetch(event({ path: "/tickets/thanks", first: false, source: "instagram", steps: ["purchase"], engagedMs: 5_000 }));
    // 訪問 B: 直接アクセス・PC・トップだけ。
    clock.set("2026-10-06T01:00:00.000Z");
    await app.fetch(
      event({ device: "desktop", os: "windows", browser: "chrome", region: "JP-13", scroll: 25, sections: ["join"], vitals: { lcp: 5000, inp: null, cls: null } }),
    );

    const res = await app.fetch(get(`/lp/insights?${RANGE}`));
    expect(res.status).toBe(200);
    const ins = await read(res);
    expect(ins.totals).toMatchObject({ views: 4, sessions: 2, purchases: 1, pagesPerSession: 2 });
    expect(ins.totals.avgSessionMs).toBe(Math.round((10_000 + 30_000 + 5_000 + 10_000) / 2));
    expect(ins.byDay.find((d) => d.date === "2026-10-05")).toEqual({ date: "2026-10-05", views: 3, sessions: 1 });
    expect(ins.byDay).toHaveLength(7);

    const ig = ins.sources.find((s) => s.key === "instagram")!;
    expect(ig).toMatchObject({ label: "Instagram 告知", sessions: 1, views: 3, purchases: 1, purchaseRatePct: 100 });
    expect(ins.sources.find((s) => s.key === "direct")).toMatchObject({ label: "直接アクセス", sessions: 1, purchases: 0 });
    expect(ins.mediums).toEqual([expect.objectContaining({ key: "social", sessions: 1 })]);
    expect(ins.campaigns[0]).toMatchObject({ key: "early-bird", sessions: 1 });
    expect(ins.referrers.map((r) => r.sessions).reduce((a, b) => a + b, 0)).toBe(2);
    expect(ins.pages.map((p) => p.key)).toEqual(["/", "/tickets", "/tickets/thanks"]);
    expect(ins.pages[0]).toMatchObject({ views: 2, sessions: 2 });
    expect(ins.devices.map((d) => [d.key, d.sessions])).toEqual([
      ["desktop", 1],
      ["mobile", 1],
    ]);
    expect(ins.regions.find((r) => r.key === "JP-17")).toMatchObject({ label: "石川県", sessions: 1 });
    expect(ins.browsers.find((b) => b.key === "instagram")?.label).toBe("Instagram アプリ内");

    // セクション到達率の分母はトップページのビュー（2）。
    expect(ins.sections.find((s) => s.key === "join")).toEqual({ key: "join", views: 2, reachPct: 100 });
    expect(ins.sections.find((s) => s.key === "program")).toEqual({ key: "program", views: 1, reachPct: 50 });
    // スクロール: 4 ビュー中、100% 到達 1・25% 以上 3（チケットページ 2 件は 50%）。
    expect(ins.scroll.find((s) => s.key === "100")).toMatchObject({ views: 1, reachPct: 25 });
    expect(ins.scroll.find((s) => s.key === "25")).toMatchObject({ views: 4, reachPct: 100 });
    // CTA: join を見たビュー 2 件に対して 2 クリック。
    expect(ins.ctas).toEqual([{ key: "tickets@join", kind: "tickets", target: null, section: "join", clicks: 2, ratePct: 100 }]);

    expect(ins.funnel.map((f) => [f.step, f.sessions, f.fromVisitPct])).toEqual([
      ["visit", 2, 100],
      ["tickets", 1, 50],
      ["checkout", 1, 50],
      ["purchase", 1, 50],
    ]);
    const lcp = ins.vitals.find((v) => v.metric === "lcp")!;
    expect(lcp).toMatchObject({ good: 1, ni: 0, poor: 1, avg: 3400 });
    expect(ins.vitals.find((v) => v.metric === "cls")).toMatchObject({ good: 1, avg: 0.02 });
  });

  it("stops recording at the daily cap (writes nothing past it)", async () => {
    const { app, clock } = await makeApp(kind, "edit", 5000, null, [], { dailyInsightCap: 2 });
    clock.set("2026-10-05T01:00:00.000Z");
    for (let i = 0; i < 4; i++) await app.fetch(event({}));
    const ins = await read(await app.fetch(get(`/lp/insights?${RANGE}`)));
    expect(ins.totals.views).toBe(2);
  });

  it("rejects a malformed body; the route is internal-only; reading needs app:lp:view", async () => {
    const { app } = await makeApp(kind);
    expect((await app.fetch(send("POST", "/lp/internal/events", { path: 1 }, INTERNAL))).status).toBe(400);
    expect((await app.fetch(send("POST", "/lp/internal/events", { path: "/", first: true }))).status).toBe(403);
    const none = (await makeApp(kind, "none")).app;
    expect((await none.fetch(get(`/lp/insights?${RANGE}`))).status).toBe(403);
    expect((await app.fetch(get("/lp/insights?from=2026-10-07&to=2026-10-01"))).status).toBe(400);
  });

  it("empty range → zero-filled days and a zero funnel", async () => {
    const { app } = await makeApp(kind, "view");
    const ins = await read(await app.fetch(get(`/lp/insights?${RANGE}`)));
    expect(ins.totals).toEqual({ views: 0, sessions: 0, avgSessionMs: 0, pagesPerSession: 0, purchases: 0 });
    expect(ins.byDay.every((d) => d.views === 0)).toBe(true);
    expect(ins.funnel.map((f) => f.sessions)).toEqual([0, 0, 0, 0]);
    expect(ins.vitals.every((v) => v.avg === null)).toBe(true);
  });
});
