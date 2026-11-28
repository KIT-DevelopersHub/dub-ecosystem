// demo (VITE_DEMO=1) の LP管理 > ログ管理「詳しい分析」。本番の lp-analytics GET /lp/insights の代わりに答える。
// 日次集計の行を固定の乱数から作り、本番と同じ lpInsights.buildInsights で画面の形にする（形のズレが起きない）。
// 数字は架空。同じ URL なら毎回同じ数字になる。
import { lpInsights } from "@dub/types";

type Row = lpInsights.LpMetricDayRow;

const DAYS = 120;
const SOURCES: [key: string, weight: number, ref: string, purchaseRate: number][] = [
  ["direct", 30, "", 0.05],
  ["instagram", 25, "l.instagram.com", 0.03],
  ["x", 14, "t.co", 0.025],
  ["connpass", 10, "connpass.com", 0.09],
  ["poster-kit", 8, "", 0.06],
  ["google", 13, "www.google.com", 0.04],
];
const SECTIONS: [id: string, reach: number][] = [
  ["top", 1],
  ["apply", 0.82],
  ["program", 0.64],
  ["about", 0.52],
  ["crowdfunding", 0.41],
  ["sponsors", 0.33],
  ["contact", 0.24],
];
const REGIONS: [string, number][] = [
  ["JP-17", 0.46],
  ["JP-16", 0.14],
  ["JP-18", 0.1],
  ["JP-13", 0.14],
  ["JP-27", 0.06],
  ["JP-23", 0.05],
];

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function generate(): Row[] {
  const rnd = random(904);
  const rows: Row[] = [];
  const today = new Date();
  for (let back = DAYS - 1; back >= 0; back -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const day = dayKey(d);
    const growth = 1 + (DAYS - back) / DAYS;
    const weekend = d.getDay() === 0 || d.getDay() === 6 ? 1.3 : 1;
    const sessions = Math.max(2, Math.round((10 + rnd() * 14) * growth * weekend));
    const acc = new Map<string, Row>();
    const add = (dim: lpInsights.LpMetricDim, key: string, n: number, s = 0, ms = 0): void => {
      const k = `${dim}|${key}`;
      const cur = acc.get(k) ?? { day, dim, key, n: 0, sessions: 0, sumMs: 0 };
      cur.n += n;
      cur.sessions += s;
      cur.sumMs += ms;
      acc.set(k, cur);
    };
    const totalW = SOURCES.reduce((a, s) => a + s[1], 0);
    for (let i = 0; i < sessions; i += 1) {
      let r = rnd() * totalW;
      const src = SOURCES.find((s) => (r -= s[1]) <= 0) ?? SOURCES[0]!;
      const mobile = rnd() < (src[0] === "instagram" || src[0] === "x" ? 0.85 : 0.55);
      const topMs = Math.round(15_000 + rnd() * 90_000);
      add("total", "", 1, 1, topMs);
      add("path", "/", 1, 1, topMs);
      add("source", src[0], 1, 1, topMs);
      add("referrer", src[2], 1, 1);
      if (src[0] === "instagram" || src[0] === "x") add("medium", "social", 1, 1);
      if (src[0] === "poster-kit") add("medium", "offline", 1, 1);
      if (src[0] === "instagram" && rnd() < 0.6) add("campaign", "early-bird", 1, 1);
      add("device", mobile ? "mobile" : rnd() < 0.08 ? "tablet" : "desktop", 1, 1);
      add("os", mobile ? (rnd() < 0.7 ? "ios" : "android") : rnd() < 0.6 ? "windows" : "macos", 1, 1);
      add(
        "browser",
        src[0] === "instagram" && rnd() < 0.7 ? "instagram" : mobile ? (rnd() < 0.7 ? "safari" : "chrome") : rnd() < 0.8 ? "chrome" : "edge",
        1,
        1,
      );
      add("country", rnd() < 0.97 ? "JP" : "TW", 1, 1);
      let rr = rnd();
      const region = REGIONS.find(([, w]) => (rr -= w) <= 0)?.[0];
      if (region) add("region", region, 1, 1);
      const depth = rnd();
      add("scroll", String(depth > 0.7 ? 100 : depth > 0.5 ? 75 : depth > 0.3 ? 50 : depth > 0.12 ? 25 : 0), 1);
      for (const [id, reach] of SECTIONS) if (rnd() < reach * (0.6 + depth * 0.5)) add("section", id, 1);
      const lcp = Math.round(mobile ? 1600 + rnd() * 2800 : 900 + rnd() * 1500);
      add("vital", `lcp:${lpInsights.vitalRating("lcp", lcp)}`, 1, 0, lcp);
      const inp = Math.round(40 + rnd() * (mobile ? 320 : 160));
      add("vital", `inp:${lpInsights.vitalRating("inp", inp)}`, 1, 0, inp);
      const cls = Math.round(rnd() * rnd() * 180);
      add("vital", `cls:${lpInsights.vitalRating("cls", cls)}`, 1, 0, cls);
      if (rnd() < 0.05) add("cta", "out:camp-fire.jp@crowdfunding", 1);
      if (rnd() < 0.03) add("cta", "sponsor@sponsors", 1);
      if (rnd() < 0.04) add("cta", "proposal@apply", 1);
      if (rnd() < 0.08) add("cta", "nav@header", 1);
      // チケットページ → 申し込み → 完了。
      if (rnd() < 0.24) {
        add("cta", rnd() < 0.6 ? "tickets@apply" : rnd() < 0.5 ? "tickets@header" : "tickets@float", 1);
        const tkMs = Math.round(20_000 + rnd() * 80_000);
        add("total", "", 1, 0, tkMs);
        add("path", "/tickets", 1, 0, tkMs);
        add("source", src[0], 1, 0, tkMs);
        add("scroll", "75", 1);
        add("funnel", "tickets", 1);
        add("funnel_src", `${src[0]}|tickets`, 1);
        if (rnd() < 0.45) {
          add("funnel", "checkout", 1);
          add("funnel_src", `${src[0]}|checkout`, 1);
          if (rnd() < src[3] * 9) {
            add("total", "", 1, 0, 6000);
            add("path", "/tickets/thanks", 1, 0, 6000);
            add("source", src[0], 1, 0, 6000);
            add("scroll", "100", 1);
            add("funnel", "purchase", 1);
            add("funnel_src", `${src[0]}|purchase`, 1);
          }
        }
      }
    }
    rows.push(...acc.values());
  }
  return rows;
}

const SOURCE_LABELS: Record<string, string> = {
  direct: "直接アクセス",
  instagram: "Instagram 告知投稿",
  x: "X(旧Twitter) 告知",
  connpass: "connpass イベントページ",
  "poster-kit": "学内ポスター QR",
  google: "google",
};
const REFERRER_LABELS: Record<string, string> = {
  "": "直接アクセス",
  "l.instagram.com": "Instagram",
  "t.co": "X(旧Twitter)",
  "connpass.com": "connpass",
  "www.google.com": "Google 検索",
};

export function createDemoLpInsightsStore() {
  let rows: Row[] | null = null;
  return {
    handle(method: string, pathname: string, url: URL): Response | null {
      if (method !== "GET" || pathname !== "/api/v1/lp/insights") return null;
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      rows ??= generate();
      const days: string[] = [];
      for (let d = new Date(`${from}T00:00:00`); dayKey(d) <= to; d.setDate(d.getDate() + 1)) days.push(dayKey(d));
      const body = lpInsights.buildInsights(
        rows.filter((r) => r.day >= from && r.day <= to),
        { from, to },
        days,
        { source: (k) => SOURCE_LABELS[k] ?? k, referrer: (h) => REFERRER_LABELS[h] ?? h },
      );
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}
