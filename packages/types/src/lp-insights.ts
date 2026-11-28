// lpInsights — LP のアクセス解析（LP管理 > ログ管理 >「詳しい分析」）。
// 公開 LP の計測スクリプト（LP Worker が差し込む）→ api-gateway（公開ビーコン。端末・地域の粗い分類だけ足す）
// → lp-analytics（日次の集計表 lp_metrics_daily に足し込む）→ LP管理が読む。3 者ともここから import する。
//
// プライバシーの約束（変えるときは PR でプライバシーポリシーの文言も見直す）:
//  - cookie を使わない。セッションはブラウザのタブ内（sessionStorage）だけで数え、識別子はサーバーに送らない。
//  - 1 人・1 訪問ごとの行を保存しない。保存するのは「日 × 項目 × 値」の件数と合計だけ（項目どうしを掛け合わせない）。
//  - IP・User-Agent そのものは保存しない（gateway が端末種別・OS・ブラウザの系統と国・都道府県に丸めて捨てる）。
//  - Do Not Track / Global Privacy Control が有効なブラウザからは何も送らない（スクリプト・gateway の両方で止める）。
//
// LP Worker が node --test（strip-only TS）で直接読むので、実行時の import は持たない。

export const LP_INSIGHT_STEPS = ["tickets", "checkout", "purchase"] as const;
/** 購入までの段階。tickets = チケットページを開いた / checkout = 申し込みを送信 / purchase = 申し込み完了ページ。 */
export type LpInsightStep = (typeof LP_INSIGHT_STEPS)[number];

export const LP_CTA_KINDS = ["tickets", "proposal", "sponsor", "contact", "nav", "out"] as const;
export type LpCtaKind = (typeof LP_CTA_KINDS)[number];

export const LP_SCROLL_BUCKETS = [0, 25, 50, 75, 100] as const;
export type LpScrollBucket = (typeof LP_SCROLL_BUCKETS)[number];

export const LP_VITAL_METRICS = ["lcp", "inp", "cls"] as const;
export type LpVitalMetric = (typeof LP_VITAL_METRICS)[number];
export type LpVitalRating = "good" | "ni" | "poor";

export type LpInsightDevice = "mobile" | "tablet" | "desktop";

/** 公開ビーコン本文の上限（文字）。 */
export const LP_INSIGHT_BODY_MAX = 4096;
export const LP_INSIGHT_MAX_SECTIONS = 24;
export const LP_INSIGHT_MAX_CTAS = 12;
/** 1 ページの滞在（表示していた時間）の上限。開きっぱなしのタブで平均が壊れないように。 */
export const LP_INSIGHT_MAX_ENGAGED_MS = 30 * 60 * 1000;
const TAG_MAX = 60;

/** ブラウザ → gateway（POST /api/v1/public/lp-events）。ページを離れる / 隠れる時に 1 回だけ送る。 */
export interface LpInsightBeacon {
  v: 1;
  /** location.pathname（クエリ・ハッシュは送らない）。 */
  path: string;
  /** このタブのセッションの最初のページか（= 1 訪問の入口）。 */
  first: boolean;
  /** セッションの入口で付いていた utm_source / utm_medium / utm_campaign。 */
  src: string | null;
  med: string | null;
  cmp: string | null;
  /** 入口の document.referrer（gateway がホスト名だけにする）。 */
  ref: string | null;
  /** ページを表示していた時間（ms）。 */
  ms: number;
  /** 最大スクロール率（0-100）。 */
  scroll: number;
  /** 半分以上見えたセクションの id。 */
  sec: string[];
  /** 押したリンク（`kind[:host]@section`）。 */
  cta: string[];
  /** このページで初めて到達した購入までの段階。 */
  steps: string[];
  /** 入口ページだけ: Core Web Vitals。 */
  vit: { lcp?: number; inp?: number; cls?: number } | null;
}

/** gateway → lp-analytics（POST /lp/internal/events）。検証・分類済み。 */
export interface LpInsightIngest {
  path: string;
  first: boolean;
  /** 生の utm_source（正規化は lp-analytics が lp_visits と同じ規則で行う）。 */
  source: string | null;
  medium: string | null;
  campaign: string | null;
  referrerHost: string | null;
  device: LpInsightDevice | null;
  os: string | null;
  browser: string | null;
  country: string | null;
  /** "JP-17" のような ISO 3166-2。 */
  region: string | null;
  engagedMs: number;
  scroll: LpScrollBucket;
  sections: string[];
  ctas: string[];
  steps: LpInsightStep[];
  vitals: { lcp: number | null; inp: number | null; cls: number | null } | null;
}

// ---- 検証（gateway と lp-analytics の両方で使う）----

const SECTION_RE = /^[a-z][a-z0-9-]{0,31}$/;
const CTA_RE = /^(tickets|proposal|sponsor|contact|nav|out(?::[a-z0-9.-]{1,60})?)@([a-z][a-z0-9-]{0,31})$/;
const PATH_RE = /^\/[a-z0-9\-_/.]{0,60}$/;
const STEP_SET: ReadonlySet<string> = new Set(LP_INSIGHT_STEPS);

function int(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function uniqueMatching(v: unknown, re: RegExp, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || !re.test(x) || out.includes(x)) continue;
    out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

/** パスを集計キーに丸める。購入者用ページ（チケット表示・領収書）は URL に秘密を含むので「(other)」に潰す。 */
export function normalizeInsightPath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/")) return "/";
  let p = (raw.split(/[?#]/)[0] ?? "/").toLowerCase();
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (/^\/tickets\/(pass|receipt)(\/|$)/.test(p)) return "(other)";
  return PATH_RE.test(p) ? p : "(other)";
}

/** utm_medium / utm_campaign。小文字・制御文字と空白の除去・60 文字まで。空なら null。 */
export function normalizeInsightTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().toLowerCase().replace(/\s+/g, "-").slice(0, TAG_MAX);
  return t.length > 0 ? t : null;
}

export function scrollBucket(pct: number): LpScrollBucket {
  if (pct >= 98) return 100;
  if (pct >= 75) return 75;
  if (pct >= 50) return 50;
  if (pct >= 25) return 25;
  return 0;
}

export function isLpInsightStep(v: unknown): v is LpInsightStep {
  return typeof v === "string" && STEP_SET.has(v);
}

/** ブラウザからの本文を検証する。形が違えば null（gateway は黙って 204 で捨てる）。 */
export function parseInsightBeacon(raw: unknown): LpInsightBeacon | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (b.v !== 1 || typeof b.path !== "string") return null;
  const ms = int(b.ms, 0, LP_INSIGHT_MAX_ENGAGED_MS);
  const scroll = int(b.scroll, 0, 100);
  const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const vit = b.vit && typeof b.vit === "object" ? (b.vit as Record<string, unknown>) : null;
  const vitals: LpInsightBeacon["vit"] = vit
    ? {
        ...(int(vit.lcp, 0, 60_000) !== null ? { lcp: int(vit.lcp, 0, 60_000)! } : {}),
        ...(int(vit.inp, 0, 30_000) !== null ? { inp: int(vit.inp, 0, 30_000)! } : {}),
        ...(typeof vit.cls === "number" && Number.isFinite(vit.cls) ? { cls: Math.min(10, Math.max(0, vit.cls)) } : {}),
      }
    : null;
  return {
    v: 1,
    path: normalizeInsightPath(b.path),
    first: b.first === true,
    src: str(b.src, 200),
    med: normalizeInsightTag(b.med),
    cmp: normalizeInsightTag(b.cmp),
    ref: str(b.ref, 500),
    ms: ms ?? 0,
    scroll: scroll ?? 0,
    sec: uniqueMatching(b.sec, SECTION_RE, LP_INSIGHT_MAX_SECTIONS),
    cta: Array.isArray(b.cta)
      ? b.cta.filter((x): x is string => typeof x === "string" && CTA_RE.test(x)).slice(0, LP_INSIGHT_MAX_CTAS)
      : [],
    steps: uniqueMatching(b.steps, /^[a-z]+$/, LP_INSIGHT_STEPS.length).filter(isLpInsightStep),
    vit: vitals && Object.keys(vitals).length > 0 ? vitals : null,
  };
}

/** lp-analytics 側の再検証（gateway を信用しない多層防御）。不正なら null。 */
export function parseInsightIngest(raw: unknown): LpInsightIngest | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.path !== "string" || typeof b.first !== "boolean") return null;
  const str = (v: unknown, re: RegExp): string | null => (typeof v === "string" && re.test(v) ? v : null);
  const devices: readonly string[] = ["mobile", "tablet", "desktop"];
  const vit = b.vitals && typeof b.vitals === "object" ? (b.vitals as Record<string, unknown>) : null;
  const num = (v: unknown, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
  return {
    path: normalizeInsightPath(b.path),
    first: b.first,
    source: typeof b.source === "string" ? b.source.slice(0, 200) : null,
    medium: normalizeInsightTag(b.medium),
    campaign: normalizeInsightTag(b.campaign),
    referrerHost: str(b.referrerHost, /^[a-z0-9.-]{1,253}(:\d{1,5})?$/),
    device: typeof b.device === "string" && devices.includes(b.device) ? (b.device as LpInsightDevice) : null,
    os: str(b.os, /^[a-z]{1,16}$/),
    browser: str(b.browser, /^[a-z]{1,16}$/),
    country: str(b.country, /^[A-Z]{2}$/),
    region: str(b.region, /^[A-Z]{2}-[A-Z0-9]{1,3}$/),
    engagedMs: int(b.engagedMs, 0, LP_INSIGHT_MAX_ENGAGED_MS) ?? 0,
    scroll: scrollBucket(int(b.scroll, 0, 100) ?? 0),
    sections: uniqueMatching(b.sections, SECTION_RE, LP_INSIGHT_MAX_SECTIONS),
    ctas: Array.isArray(b.ctas)
      ? b.ctas.filter((x): x is string => typeof x === "string" && CTA_RE.test(x)).slice(0, LP_INSIGHT_MAX_CTAS)
      : [],
    steps: uniqueMatching(b.steps, /^[a-z]+$/, LP_INSIGHT_STEPS.length).filter(isLpInsightStep),
    vitals: vit ? { lcp: num(vit.lcp, 60_000), inp: num(vit.inp, 30_000), cls: num(vit.cls, 10) } : null,
  };
}

// ---- 端末の粗い分類（gateway）。UA は分類に使ったら捨てる ----

const BOT_RE =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|whatsapp|headless|lighthouse|pagespeed|phantomjs|python-requests|curl\/|wget\//i;

export interface LpClientClass {
  device: LpInsightDevice | "bot";
  os: string;
  browser: string;
}

/**
 * User-Agent と低エントロピーの Client Hints（Sec-CH-UA-Mobile / Sec-CH-UA-Platform。Chromium が既定で送る）から
 * 端末種別・OS・ブラウザの「系統」だけを出す。版数や機種は出さない（個体の識別に使えないように）。
 */
export function classifyClient(ua: string | null | undefined, hints: { mobile?: string | null; platform?: string | null } = {}): LpClientClass {
  const u = ua ?? "";
  if (!u || BOT_RE.test(u)) return { device: "bot", os: "other", browser: "other" };
  const platform = (hints.platform ?? "").replace(/"/g, "").toLowerCase();
  let os = "other";
  if (/iphone|ipad|ipod/i.test(u) || platform === "ios") os = "ios";
  else if (/android/i.test(u) || platform === "android") os = "android";
  else if (/windows/i.test(u) || platform === "windows") os = "windows";
  else if (/cros/i.test(u) || platform === "chrome os") os = "chromeos";
  else if (/mac os x|macintosh/i.test(u) || platform === "macos") os = "macos";
  else if (/linux/i.test(u) || platform === "linux") os = "linux";

  let device: LpInsightDevice;
  if (/ipad|tablet/i.test(u) || (os === "android" && !/mobile/i.test(u))) device = "tablet";
  else if (hints.mobile === "?1" || /mobi|iphone|ipod/i.test(u)) device = "mobile";
  else device = "desktop";

  // アプリ内ブラウザ（SNS からの流入で多い）を先に見る。
  let browser = "other";
  if (/\bline\//i.test(u)) browser = "line";
  else if (/instagram/i.test(u)) browser = "instagram";
  else if (/fban|fbav|fb_iab/i.test(u)) browser = "facebook";
  else if (/twitter/i.test(u)) browser = "x";
  else if (/edg(e|a|ios)?\//i.test(u)) browser = "edge";
  else if (/samsungbrowser/i.test(u)) browser = "samsung";
  else if (/firefox|fxios/i.test(u)) browser = "firefox";
  else if (/opr\//i.test(u)) browser = "opera";
  else if (/chrome|crios/i.test(u)) browser = "chrome";
  else if (/safari/i.test(u)) browser = "safari";
  return { device, os, browser };
}

/** Cloudflare の cf.country / cf.regionCode → "JP-17"。どちらか欠ければ null。 */
export function regionKey(country: string | null | undefined, regionCode: unknown): string | null {
  if (!country || !/^[A-Z]{2}$/.test(country)) return null;
  if (typeof regionCode !== "string" || !/^[A-Za-z0-9]{1,3}$/.test(regionCode)) return null;
  return `${country}-${regionCode.toUpperCase()}`;
}

// ---- 日次集計の行（lp_metrics_daily）----

export const LP_METRIC_DIMS = [
  "total",
  "path",
  "source",
  "medium",
  "campaign",
  "referrer",
  "device",
  "os",
  "browser",
  "country",
  "region",
  "scroll",
  "section",
  "cta",
  "funnel",
  "funnel_src",
  "vital",
] as const;
export type LpMetricDim = (typeof LP_METRIC_DIMS)[number];

/** n = ページビュー（または件数）/ sessions = その行で始まった訪問 / sumMs = 表示時間などの合計。 */
export interface LpMetricRow {
  dim: LpMetricDim;
  key: string;
  n: number;
  sessions: number;
  sumMs: number;
}

/** Core Web Vitals の判定（web.dev の閾値）。CLS は 1000 倍した整数で持つ。 */
export function vitalRating(metric: LpVitalMetric, value: number): LpVitalRating {
  const [good, poor] = metric === "lcp" ? [2500, 4000] : metric === "inp" ? [200, 500] : [100, 250];
  return value <= good ? "good" : value <= poor ? "ni" : "poor";
}

/**
 * 1 ビーコン → 足し込む集計行。訪問の属性（流入元・端末・地域など）は入口ページの時だけ数える
 * （同じ訪問の 2 ページ目で二重に数えない）。`source` は正規化済み（lp_visits と同じ "direct" 規則）。
 */
export function insightRows(i: LpInsightIngest & { source: string }): LpMetricRow[] {
  const s = i.first ? 1 : 0;
  const rows: LpMetricRow[] = [
    { dim: "total", key: "", n: 1, sessions: s, sumMs: i.engagedMs },
    { dim: "path", key: i.path, n: 1, sessions: s, sumMs: i.engagedMs },
    { dim: "source", key: i.source, n: 1, sessions: s, sumMs: i.engagedMs },
    { dim: "scroll", key: String(i.scroll), n: 1, sessions: 0, sumMs: 0 },
  ];
  if (i.first) {
    const once = (dim: LpMetricDim, key: string | null): void => {
      if (key !== null) rows.push({ dim, key, n: 1, sessions: 1, sumMs: 0 });
    };
    once("medium", i.medium);
    once("campaign", i.campaign);
    once("referrer", i.referrerHost ?? "");
    once("device", i.device);
    once("os", i.os);
    once("browser", i.browser);
    once("country", i.country);
    once("region", i.region);
    if (i.vitals) {
      for (const m of LP_VITAL_METRICS) {
        const raw = i.vitals[m];
        if (raw === null) continue;
        const v = m === "cls" ? Math.round(raw * 1000) : Math.round(raw);
        rows.push({ dim: "vital", key: `${m}:${vitalRating(m, v)}`, n: 1, sessions: 0, sumMs: v });
      }
    }
  }
  for (const sec of i.sections) rows.push({ dim: "section", key: sec, n: 1, sessions: 0, sumMs: 0 });
  const clicks = new Map<string, number>();
  for (const c of i.ctas) clicks.set(c, (clicks.get(c) ?? 0) + 1);
  for (const [key, n] of clicks) rows.push({ dim: "cta", key, n, sessions: 0, sumMs: 0 });
  for (const step of i.steps) {
    rows.push({ dim: "funnel", key: step, n: 1, sessions: 0, sumMs: 0 });
    rows.push({ dim: "funnel_src", key: `${i.source}|${step}`, n: 1, sessions: 0, sumMs: 0 });
  }
  return rows;
}

// ---- LP管理が読む形（GET /lp/insights）----

export interface LpInsightBucket {
  key: string;
  label: string;
  views: number;
  sessions: number;
  /** 平均表示時間（ms / ページビュー）。 */
  avgEngagedMs: number;
}

export interface LpInsightSourceBucket extends LpInsightBucket {
  /** この流入元で始まった訪問のうち購入（申し込み完了）まで進んだ数と率。 */
  purchases: number;
  purchaseRatePct: number;
}

export interface LpInsightReach {
  key: string;
  views: number;
  /** 分母（トップページのビュー数）に対する到達率。 */
  reachPct: number;
}

export interface LpInsightCta {
  key: string;
  kind: LpCtaKind;
  /** out の時だけ: リンク先のホスト。 */
  target: string | null;
  section: string;
  clicks: number;
  /** そのセクションを見たビューのうち押した割合（セクションの記録が無ければトップページのビュー比）。 */
  ratePct: number;
}

export interface LpInsightFunnelStep {
  step: "visit" | LpInsightStep;
  sessions: number;
  /** 前の段階からの通過率。 */
  fromPrevPct: number;
  /** 訪問からの通過率。 */
  fromVisitPct: number;
}

export interface LpInsightVital {
  metric: LpVitalMetric;
  good: number;
  ni: number;
  poor: number;
  /** 平均（LCP・INP は ms、CLS は 0.xx）。計測 0 件なら null。 */
  avg: number | null;
}

export interface LpInsights {
  range: { from: string; to: string };
  totals: {
    views: number;
    sessions: number;
    /** 1 訪問あたりの平均滞在（ms）。 */
    avgSessionMs: number;
    pagesPerSession: number;
    purchases: number;
  };
  byDay: { date: string; views: number; sessions: number }[];
  sources: LpInsightSourceBucket[];
  mediums: LpInsightBucket[];
  campaigns: LpInsightBucket[];
  referrers: LpInsightBucket[];
  pages: LpInsightBucket[];
  devices: LpInsightBucket[];
  os: LpInsightBucket[];
  browsers: LpInsightBucket[];
  countries: LpInsightBucket[];
  regions: LpInsightBucket[];
  sections: LpInsightReach[];
  scroll: LpInsightReach[];
  ctas: LpInsightCta[];
  funnel: LpInsightFunnelStep[];
  vitals: LpInsightVital[];
}

export interface LpMetricDayRow extends LpMetricRow {
  day: string;
}

const pct = (num: number, den: number): number => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

/**
 * 集計行 → 画面の形。lp-analytics と LP管理のデモ（demo-seed）が同じ関数を使う。
 * `days` は期間の全日（0 件の日も並べる）。label は流入元（発行した名前）・リファラ（サービス名）だけ呼び出し側が決める。
 */
export function buildInsights(
  rows: readonly LpMetricDayRow[],
  range: { from: string; to: string },
  days: readonly string[],
  labels: { source?: (key: string) => string; referrer?: (host: string) => string } = {},
): LpInsights {
  const sums = new Map<string, { n: number; sessions: number; sumMs: number }>();
  const perDay = new Map<string, { views: number; sessions: number }>();
  for (const r of rows) {
    const k = `${r.dim}\u0000${r.key}`;
    const cur = sums.get(k) ?? { n: 0, sessions: 0, sumMs: 0 };
    cur.n += r.n;
    cur.sessions += r.sessions;
    cur.sumMs += r.sumMs;
    sums.set(k, cur);
    if (r.dim === "total") {
      const d = perDay.get(r.day) ?? { views: 0, sessions: 0 };
      d.views += r.n;
      d.sessions += r.sessions;
      perDay.set(r.day, d);
    }
  }
  const of = (dim: LpMetricDim): { key: string; n: number; sessions: number; sumMs: number }[] => {
    const out: { key: string; n: number; sessions: number; sumMs: number }[] = [];
    const prefix = `${dim}\u0000`;
    for (const [k, v] of sums) if (k.startsWith(prefix)) out.push({ key: k.slice(prefix.length), ...v });
    return out;
  };
  const get = (dim: LpMetricDim, key: string) => sums.get(`${dim}\u0000${key}`) ?? { n: 0, sessions: 0, sumMs: 0 };

  const total = get("total", "");
  const bucket = (dim: LpMetricDim, label: (k: string) => string = (k) => k, by: "views" | "sessions" = "sessions"): LpInsightBucket[] =>
    of(dim)
      .map((r) => ({ key: r.key, label: label(r.key), views: r.n, sessions: r.sessions, avgEngagedMs: r.n > 0 ? Math.round(r.sumMs / r.n) : 0 }))
      .sort((a, b) => b[by] - a[by] || b.views - a.views || a.key.localeCompare(b.key));

  const purchasesBySource = new Map<string, number>();
  for (const r of of("funnel_src")) {
    const [src, step] = r.key.split("|");
    if (step === "purchase" && src !== undefined) purchasesBySource.set(src, (purchasesBySource.get(src) ?? 0) + r.n);
  }
  const sources = bucket("source", labels.source).map((b) => {
    const purchases = purchasesBySource.get(b.key) ?? 0;
    return { ...b, purchases, purchaseRatePct: pct(purchases, b.sessions) };
  });

  // セクションとクリック率の分母はトップページ（"/"）のビュー。トップ以外のページにはセクションが無い。
  const topViews = get("path", "/").n || total.n;
  const sectionViews = new Map(of("section").map((r) => [r.key, r.n]));
  const sections = of("section")
    .map((r) => ({ key: r.key, views: r.n, reachPct: pct(r.n, topViews) }))
    .sort((a, b) => b.views - a.views || a.key.localeCompare(b.key));

  const scrollRows = of("scroll");
  const scrollTotal = scrollRows.reduce((s, r) => s + r.n, 0);
  const scroll = LP_SCROLL_BUCKETS.filter((t) => t > 0).map((t) => {
    const views = scrollRows.filter((r) => Number(r.key) >= t).reduce((s, r) => s + r.n, 0);
    return { key: String(t), views, reachPct: pct(views, scrollTotal) };
  });

  const ctas = of("cta")
    .map((r): LpInsightCta => {
      const at = r.key.lastIndexOf("@");
      const head = r.key.slice(0, at);
      const section = r.key.slice(at + 1);
      const [kind, target] = head.split(":");
      const den = sectionViews.get(section) ?? topViews;
      return { key: r.key, kind: kind as LpCtaKind, target: target ?? null, section, clicks: r.n, ratePct: pct(r.n, den) };
    })
    .sort((a, b) => b.clicks - a.clicks || a.key.localeCompare(b.key));

  const visit = total.sessions;
  const funnel: LpInsightFunnelStep[] = [{ step: "visit", sessions: visit, fromPrevPct: 100, fromVisitPct: visit > 0 ? 100 : 0 }];
  for (const step of LP_INSIGHT_STEPS) {
    const n = get("funnel", step).n;
    const prev = funnel[funnel.length - 1]!.sessions;
    funnel.push({ step, sessions: n, fromPrevPct: pct(n, prev), fromVisitPct: pct(n, visit) });
  }

  const vitals = LP_VITAL_METRICS.map((metric): LpInsightVital => {
    const g = get("vital", `${metric}:good`);
    const ni = get("vital", `${metric}:ni`);
    const p = get("vital", `${metric}:poor`);
    const count = g.n + ni.n + p.n;
    const sum = g.sumMs + ni.sumMs + p.sumMs;
    const avg = count > 0 ? (metric === "cls" ? Math.round(sum / count) / 1000 : Math.round(sum / count)) : null;
    return { metric, good: g.n, ni: ni.n, poor: p.n, avg };
  });

  return {
    range,
    totals: {
      views: total.n,
      sessions: total.sessions,
      avgSessionMs: total.sessions > 0 ? Math.round(total.sumMs / total.sessions) : 0,
      pagesPerSession: total.sessions > 0 ? Math.round((total.n / total.sessions) * 10) / 10 : 0,
      purchases: get("funnel", "purchase").n,
    },
    byDay: days.map((date) => ({ date, views: perDay.get(date)?.views ?? 0, sessions: perDay.get(date)?.sessions ?? 0 })),
    sources,
    mediums: bucket("medium"),
    campaigns: bucket("campaign"),
    referrers: bucket("referrer", labels.referrer),
    pages: bucket("path", (k) => k, "views"),
    devices: bucket("device", (k) => LP_DEVICE_LABELS[k] ?? k),
    os: bucket("os", (k) => LP_OS_LABELS[k] ?? k),
    browsers: bucket("browser", (k) => LP_BROWSER_LABELS[k] ?? k),
    countries: bucket("country"),
    regions: bucket("region", (k) => JP_PREFECTURES[k] ?? k),
    sections,
    scroll,
    ctas,
    funnel,
    vitals,
  };
}

// ---- 表示名 ----

export const LP_DEVICE_LABELS: Readonly<Record<string, string>> = { mobile: "スマホ", tablet: "タブレット", desktop: "PC" };
export const LP_OS_LABELS: Readonly<Record<string, string>> = {
  ios: "iOS",
  android: "Android",
  windows: "Windows",
  macos: "macOS",
  chromeos: "ChromeOS",
  linux: "Linux",
  other: "その他",
};
export const LP_BROWSER_LABELS: Readonly<Record<string, string>> = {
  chrome: "Chrome",
  safari: "Safari",
  edge: "Edge",
  firefox: "Firefox",
  samsung: "Samsung Internet",
  opera: "Opera",
  line: "LINE アプリ内",
  instagram: "Instagram アプリ内",
  facebook: "Facebook アプリ内",
  x: "X アプリ内",
  other: "その他",
};
export const LP_STEP_LABELS: Readonly<Record<LpInsightFunnelStep["step"], string>> = {
  visit: "LP を訪問",
  tickets: "チケットページを開いた",
  checkout: "申し込みを送信",
  purchase: "申し込み完了",
};
export const LP_CTA_KIND_LABELS: Readonly<Record<LpCtaKind, string>> = {
  tickets: "チケット購入",
  proposal: "登壇応募",
  sponsor: "スポンサー募集",
  contact: "お問い合わせ",
  nav: "ページ内リンク",
  out: "外部リンク",
};
export const LP_VITAL_LABELS: Readonly<Record<LpVitalMetric, string>> = {
  lcp: "LCP（表示の速さ）",
  inp: "INP（操作への反応）",
  cls: "CLS（レイアウトのずれ）",
};
/** ISO 3166-2:JP → 都道府県名。 */
export const JP_PREFECTURES: Readonly<Record<string, string>> = {
  "JP-01": "北海道", "JP-02": "青森県", "JP-03": "岩手県", "JP-04": "宮城県", "JP-05": "秋田県", "JP-06": "山形県",
  "JP-07": "福島県", "JP-08": "茨城県", "JP-09": "栃木県", "JP-10": "群馬県", "JP-11": "埼玉県", "JP-12": "千葉県",
  "JP-13": "東京都", "JP-14": "神奈川県", "JP-15": "新潟県", "JP-16": "富山県", "JP-17": "石川県", "JP-18": "福井県",
  "JP-19": "山梨県", "JP-20": "長野県", "JP-21": "岐阜県", "JP-22": "静岡県", "JP-23": "愛知県", "JP-24": "三重県",
  "JP-25": "滋賀県", "JP-26": "京都府", "JP-27": "大阪府", "JP-28": "兵庫県", "JP-29": "奈良県", "JP-30": "和歌山県",
  "JP-31": "鳥取県", "JP-32": "島根県", "JP-33": "岡山県", "JP-34": "広島県", "JP-35": "山口県", "JP-36": "徳島県",
  "JP-37": "香川県", "JP-38": "愛媛県", "JP-39": "高知県", "JP-40": "福岡県", "JP-41": "佐賀県", "JP-42": "長崎県",
  "JP-43": "熊本県", "JP-44": "大分県", "JP-45": "宮崎県", "JP-46": "鹿児島県", "JP-47": "沖縄県",
};
