import { describe, it, expect } from "vitest";
import { dayJst, sourceFromParam } from "../src/domain";
import type { LpLinkSummary, LpStats, LpVisitsPage } from "../src/types";
import { get, ingest, makeApp, send, type RepoKind } from "./harness";

const RANGE = "from=2026-10-01&to=2026-10-07";
const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;

describe.each<RepoKind>(["memory", "d1"])("lp-analytics (%s repo)", (kind) => {
  it("issues a 流入URL: normalized slug, server-built URL, zero stats", async () => {
    const { app } = await makeApp(kind);
    const res = await app.fetch(send("POST", `/lp/links?${RANGE}`, { name: " Instagram 告知 ", slug: "Instagram" }));
    expect(res.status).toBe(201);
    const link = await body<LpLinkSummary>(res);
    expect(link).toMatchObject({
      name: "Instagram 告知",
      slug: "instagram",
      url: "https://hokuriku-it-conf.com/?utm_source=instagram",
      active: true,
      stats: { visits: 0, uniques: 0, lastVisitAt: null },
    });
  });

  it("duplicate slug (case-insensitive) → 409; invalid / reserved slug → 400", async () => {
    const { app } = await makeApp(kind);
    await app.fetch(send("POST", `/lp/links?${RANGE}`, { name: "X", slug: "x" }));
    expect((await app.fetch(send("POST", `/lp/links?${RANGE}`, { name: "X2", slug: "X" }))).status).toBe(409);
    expect((await app.fetch(send("POST", `/lp/links?${RANGE}`, { name: "a", slug: "日本語" }))).status).toBe(400);
    expect((await app.fetch(send("POST", `/lp/links?${RANGE}`, { name: "a", slug: "direct" }))).status).toBe(400);
    expect((await app.fetch(send("POST", `/lp/links?${RANGE}`, { name: "", slug: "ok" }))).status).toBe(400);
  });

  it("records beacons, attributes them to the link, and aggregates per link", async () => {
    const { app, clock } = await makeApp(kind);
    const link = await body<LpLinkSummary>(await app.fetch(send("POST", `/lp/links?${RANGE}`, { name: "IG", slug: "instagram" })));

    clock.set("2026-10-05T01:00:00.000Z");
    expect((await app.fetch(ingest({ source: "instagram", visitorKey: "a" }))).status).toBe(204);
    clock.set("2026-10-06T01:00:00.000Z");
    await app.fetch(ingest({ source: "INSTAGRAM", visitorKey: "a" })); // revisit, case-folded
    await app.fetch(ingest({ source: "instagram", visitorKey: "b" }));
    await app.fetch(ingest({ source: "instagram", visitorKey: "bot1", device: "bot" })); // excluded
    await app.fetch(ingest({ visitorKey: "c" })); // direct

    const list = await body<{ items: LpLinkSummary[] }>(await app.fetch(get(`/lp/links?${RANGE}`)));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.id).toBe(link.id);
    expect(list.items[0]!.stats).toEqual({ visits: 3, uniques: 2, lastVisitAt: "2026-10-06T01:00:00.000Z" });

    const page = await body<LpVisitsPage>(await app.fetch(get(`/lp/visits?${RANGE}`)));
    expect(page.items.map((v) => v.source)).toEqual(["direct", "instagram", "instagram", "instagram"]);
    expect(page.items[0]).toMatchObject({ kind: "ingest", linkId: null });
    expect(page.items[1]).toMatchObject({ kind: "redirect", linkId: link.id, device: "mobile" });
    // internal fields never reach the wire.
    expect(Object.keys(page.items[0]!)).not.toContain("visitorKey");
  });

  it("stats: totals, bot exclusion, labelled sources, zero-filled days, devices", async () => {
    const { app, clock } = await makeApp(kind);
    await app.fetch(send("POST", `/lp/links?${RANGE}`, { name: "Instagram 告知", slug: "instagram" }));
    clock.set("2026-10-02T01:00:00.000Z");
    await app.fetch(ingest({ source: "instagram", visitorKey: "a", path: "/" }));
    await app.fetch(ingest({ source: "instagram", visitorKey: "a", path: "/#program" })); // other page → counts
    await app.fetch(ingest({ visitorKey: "b", device: "desktop" }));
    await app.fetch(ingest({ source: "tiktok", visitorKey: "c" })); // tagged but never issued
    await app.fetch(ingest({ visitorKey: "g", device: "bot" }));

    const s = await body<LpStats>(await app.fetch(get(`/lp/stats?${RANGE}`)));
    expect(s.range).toEqual({ from: "2026-10-01", to: "2026-10-07" });
    expect(s.totals).toEqual({ visits: 4, uniques: 3, botExcluded: 1 });
    expect(s.bySource[0]).toEqual({ key: "instagram", label: "Instagram 告知", visits: 2, uniques: 1 });
    expect(s.bySource.find((b) => b.key === "direct")?.label).toBe("直接アクセス");
    expect(s.bySource.find((b) => b.key === "tiktok")?.label).toBe("tiktok");
    expect(s.byDay).toHaveLength(7);
    expect(s.byDay.find((d) => d.date === "2026-10-02")?.visits).toBe(4);
    expect(s.byDay.find((d) => d.date === "2026-10-03")?.visits).toBe(0);
    expect(s.byDevice[0]).toEqual({ key: "mobile", label: "スマホ", visits: 3, uniques: 2 });

    const withBots = await body<LpStats>(await app.fetch(get(`/lp/stats?${RANGE}&includeBots=true`)));
    expect(withBots.totals).toEqual({ visits: 5, uniques: 4, botExcluded: 0 });
  });

  it("a reload (same visitor/day/source/page) is one visit; next day counts again", async () => {
    const { app, clock } = await makeApp(kind);
    clock.set("2026-10-05T01:00:00.000Z");
    for (let i = 0; i < 3; i += 1) await app.fetch(ingest({ source: "x", visitorKey: "a", path: "/" }));
    clock.set("2026-10-06T01:00:00.000Z");
    await app.fetch(ingest({ source: "x", visitorKey: "a", path: "/" }));
    const s = await body<LpStats>(await app.fetch(get(`/lp/stats?${RANGE}`)));
    expect(s.totals).toMatchObject({ visits: 2, uniques: 1 });
  });

  it("daily cap: over the cap the beacon is accepted (204) but not recorded", async () => {
    const { app, clock } = await makeApp(kind, "edit", 2);
    for (const k of ["a", "b", "c", "d"]) expect((await app.fetch(ingest({ visitorKey: k }))).status).toBe(204);
    clock.set("2026-10-08T03:00:00.000Z"); // next JST day → counter resets
    await app.fetch(ingest({ visitorKey: "e" }));
    const s = await body<LpStats>(await app.fetch(get(`/lp/stats?from=2026-10-01&to=2026-10-08`)));
    expect(s.totals.visits).toBe(3);
  });

  it("days are cut in JST (23:30 JST stays on that day, not the UTC previous one)", async () => {
    const { app, clock } = await makeApp(kind);
    clock.set("2026-10-06T15:30:00.000Z"); // = 2026-10-07 00:30 JST
    await app.fetch(ingest({ visitorKey: "a" }));
    const s = await body<LpStats>(await app.fetch(get(`/lp/stats?from=2026-10-07&to=2026-10-07`)));
    expect(s.totals.visits).toBe(1);
  });

  it("visits: keyset pagination + source filter", async () => {
    const { app } = await makeApp(kind);
    for (let i = 0; i < 5; i += 1) await app.fetch(ingest({ source: i % 2 ? "x" : "line", visitorKey: `v${i}` }));
    const p1 = await body<LpVisitsPage>(await app.fetch(get(`/lp/visits?${RANGE}&limit=2`)));
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBe(`2026-10-07~${p1.items[1]!.id}`);
    const p2 = await body<LpVisitsPage>(await app.fetch(get(`/lp/visits?${RANGE}&limit=2&cursor=${p1.nextCursor}`)));
    const p3 = await body<LpVisitsPage>(await app.fetch(get(`/lp/visits?${RANGE}&limit=2&cursor=${p2.nextCursor}`)));
    expect(p3.items).toHaveLength(1);
    expect(p3.nextCursor).toBeNull();
    const ids = [...p1.items, ...p2.items, ...p3.items].map((v) => v.id);
    expect(new Set(ids).size).toBe(5);

    const onlyX = await body<LpVisitsPage>(await app.fetch(get(`/lp/visits?${RANGE}&source=x`)));
    expect(onlyX.items.every((v) => v.source === "x")).toBe(true);
    expect(onlyX.items).toHaveLength(2);
  });

  it("pausing keeps counting already-shared URLs (集計は消えない)", async () => {
    const { app } = await makeApp(kind);
    const link = await body<LpLinkSummary>(await app.fetch(send("POST", `/lp/links?${RANGE}`, { name: "Poster", slug: "poster" })));
    await app.fetch(ingest({ source: "poster", visitorKey: "a" }));
    const paused = await body<LpLinkSummary>(await app.fetch(send("PATCH", `/lp/links/${link.id}?${RANGE}`, { active: false })));
    expect(paused).toMatchObject({ active: false, stats: { visits: 1 } });
    await app.fetch(ingest({ source: "poster", visitorKey: "b" }));
    const list = await body<{ items: LpLinkSummary[] }>(await app.fetch(get(`/lp/links?${RANGE}`)));
    expect(list.items[0]).toMatchObject({ active: false, stats: { visits: 2, uniques: 2 } });
    expect((await app.fetch(send("PATCH", `/lp/links/lnk_missing?${RANGE}`, { active: true }))).status).toBe(404);
  });

  it("rejects bad ranges", async () => {
    const { app } = await makeApp(kind);
    expect((await app.fetch(get("/lp/stats?from=2026-10-07&to=2026-10-01"))).status).toBe(400);
    expect((await app.fetch(get("/lp/stats?from=2026-02-30&to=2026-03-01"))).status).toBe(400);
    expect((await app.fetch(get("/lp/stats"))).status).toBe(400);
    expect((await app.fetch(get("/lp/stats?from=2026-01-01&to=2026-06-01"))).status).toBe(400);
  });
});

describe("policy gate (LP管理)", () => {
  it("無効 → 403 on read; 閲覧 → read ok, write 403; unauthenticated → 401", async () => {
    const none = await makeApp("memory", "none");
    expect((await none.app.fetch(get(`/lp/stats?${RANGE}`))).status).toBe(403);

    const view = await makeApp("memory", "view");
    expect((await view.app.fetch(get(`/lp/links?${RANGE}`))).status).toBe(200);
    expect((await view.app.fetch(send("POST", `/lp/links?${RANGE}`, { name: "X", slug: "x" }))).status).toBe(403);

    expect((await view.app.fetch(get(`/lp/stats?${RANGE}`, {}))).status).toBe(401);
  });

  it("the beacon landing is s2s only (404 without x-dub-internal)", async () => {
    const { app } = await makeApp("memory");
    const res = await app.fetch(send("POST", "/lp/internal/visits", { device: "mobile", visitorKey: "a" }, {}));
    expect(res.status).toBe(404);
    expect((await app.fetch(ingest({ device: "tablet" }))).status).toBe(400);
  });
});

describe("domain", () => {
  it("dayJst / sourceFromParam", () => {
    expect(dayJst("2026-10-06T14:59:59.000Z")).toBe("2026-10-06");
    expect(dayJst("2026-10-06T15:00:00.000Z")).toBe("2026-10-07");
    expect(sourceFromParam(null)).toBe("direct");
    expect(sourceFromParam("  Instagram ")).toBe("instagram");
    expect(sourceFromParam("<script>")).toBe("script");
    expect(sourceFromParam("日本語")).toBe("direct");
  });
});
