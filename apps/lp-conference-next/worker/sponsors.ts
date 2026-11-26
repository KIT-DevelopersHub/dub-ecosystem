// Public sponsor page (/sponsors*) for the LP Worker: スポンサー資料の請求フォーム。
// Gated by the sponsor flag served by lp-analytics (GET /lp/internal/sponsor-inquiries), toggled in
// LP管理 > スポンサー募集. While on, the LP's JOIN スポンサー card is swapped from 準備中 to a link here
// (same in-place swap as the 登壇 card in ./proposals.ts). Same look / helpers as /tickets.
// Pure logic + a dependency-injected handler: no runtime imports outside this app, so it runs under both
// workerd and `node --test` (strip-only TS: no enums / parameter properties).
import {
  LP_SPONSOR_COMPANY_MAX,
  LP_SPONSOR_EMAIL_MAX,
  LP_SPONSOR_MESSAGE_MAX,
  LP_SPONSOR_NAME_MAX,
  parseLpSponsorInquiry,
  type LpSponsorInquiryInput,
} from "../../../packages/types/src/lp-sponsor.ts";
import {
  BASE_HEADERS,
  HONEYPOT,
  ctaSwapScript,
  errMsg,
  escapeHtml,
  hero,
  htmlResponse,
  redirect,
  reqMark,
  senderKeyFor,
  shell,
  type FormErrors,
  type FormValues,
} from "./tickets.ts";

export interface SponsorConfig {
  enabled: boolean;
}

const BODY_MAX = 16 * 1024;
const STEPS = ["資料のご請求", "スポンサーチームから資料送付", "ご検討・お申し込み"];
const DEMO_NOTE = "デモ環境です（送信内容は保存されず、メールも送られません）";
export const USAGE_NOTE = "ご入力いただいた情報は、スポンサー資料の送付とご連絡にのみ使用します。";
const FIELD_LABELS: Record<keyof LpSponsorInquiryInput, string> = {
  companyName: "会社名",
  contactName: "ご担当者名",
  email: "メールアドレス",
  message: "ひとこと",
};

/** Demo has no lp-analytics: shown as open so the flow can be tried end to end (nothing is saved). */
export const DEMO_SPONSOR_CONFIG: SponsorConfig = { enabled: true };

export function matchSponsorsRoute(pathname: string): "page" | "submit" | "thanks" | null {
  const p = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (p === "/sponsors") return "page";
  if (p === "/sponsors/submit") return "submit";
  if (p === "/sponsors/thanks") return "thanks";
  return null;
}

export function isSponsorsPath(pathname: string): boolean {
  return pathname === "/sponsors" || pathname.startsWith("/sponsors/");
}

/** Validates the internal config payload; null when malformed. */
export function parseSponsorConfig(raw: unknown): SponsorConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return typeof o.enabled === "boolean" ? { enabled: o.enabled } : null;
}

// ---------- form parsing ----------

export type SponsorParseResult =
  | { ok: true; input: LpSponsorInquiryInput; values: FormValues }
  | { ok: false; spam: boolean; values: FormValues; errors: FormErrors };

export function parseSponsorForm(form: URLSearchParams): SponsorParseResult {
  const values: FormValues = {};
  const get = (k: string): string => (form.get(k) ?? "").trim();
  if (get(HONEYPOT)) return { ok: false, spam: true, values, errors: {} };
  for (const k of Object.keys(FIELD_LABELS)) values[k] = get(k);
  const { input, issues } = parseLpSponsorInquiry(values);
  if (issues.length === 0) return { ok: true, input, values };
  const errors: FormErrors = {};
  for (const i of issues) {
    const label = FIELD_LABELS[i.field];
    errors[i.field] =
      i.reason === "required"
        ? `${label}を入力してください`
        : i.reason === "too_long"
          ? `${label}が長すぎます`
          : "メールアドレスの形式が正しくありません";
  }
  return { ok: false, spam: false, values, errors };
}

/** lp-analytics error → inline errors (400 per-field, 404 closed, 429 cap, else generic). */
export function mapSponsorSubmitError(status: number, body: unknown): FormErrors {
  if (status === 400) {
    const details = (body as { error?: { details?: unknown } } | null)?.error?.details;
    const out: FormErrors = {};
    if (Array.isArray(details)) {
      for (const d of details) {
        const field = typeof d?.field === "string" ? (d.field as string) : "";
        if (field in FIELD_LABELS) out[field] = "入力内容を確認してください";
      }
    }
    out._form = "入力内容を確認してください。";
    return out;
  }
  if (status === 404) return { _form: "現在、スポンサーの募集は行っていません。" };
  if (status === 429) {
    return { _form: "短い時間に多くの送信があったため受け付けられませんでした。時間をおいてもう一度お試しください。" };
  }
  return { _form: "送信できませんでした。時間をおいてもう一度お試しください。" };
}

// ---------- rendering ----------

function input(
  key: keyof LpSponsorInquiryInput,
  required: boolean,
  values: FormValues,
  errors: FormErrors,
  attrs: string,
): string {
  const aria = errors[key] ? ` aria-invalid="true" aria-describedby="${key}-err"` : "";
  return (
    `<div class="field${errors[key] ? " bad" : ""}"><label class="lbl" for="${key}">${FIELD_LABELS[key]}${reqMark(required)}</label>` +
    `<input ${attrs} id="${key}" name="${key}" value="${escapeHtml(values[key] ?? "")}"${required ? " required" : ""}${aria}>` +
    `${errMsg(errors, key)}</div>`
  );
}

export function renderSponsorsPage(o: { values?: FormValues; errors?: FormErrors; demo?: boolean }): string {
  const values = o.values ?? {};
  const errors = o.errors ?? {};
  const top = hero({
    title: 'スポンサー<span class="g">募集</span>',
    sub: "北陸ITカンファレンスを一緒につくりませんか。スポンサー資料をお送りします。",
    ghost: "SPONSORS",
    eyebrow: "SPONSORSHIP",
    step: 1,
    steps: STEPS,
  });
  const alerts = errors._form ? `<div class="alert err" role="alert">${escapeHtml(errors._form)}</div>` : "";
  const msgAria = errors.message ? ' aria-invalid="true" aria-describedby="message-err"' : "";
  const form =
    '<form class="buy" method="post" action="/sponsors/submit" novalidate data-lp-sponsors-form>' +
    alerts +
    '<section class="card rv"><div class="shead"><span class="no">01</span><h2>資料を請求する</h2><p>資料はメールでお送りします</p></div>' +
    `<div class="two">${input("companyName", false, values, errors, `type="text" autocomplete="organization" maxlength="${LP_SPONSOR_COMPANY_MAX}" placeholder="株式会社〇〇"`)}` +
    `${input("contactName", false, values, errors, `type="text" autocomplete="name" maxlength="${LP_SPONSOR_NAME_MAX}" placeholder="北陸 太郎"`)}</div>` +
    input("email", true, values, errors, `type="email" autocomplete="email" maxlength="${LP_SPONSOR_EMAIL_MAX}" placeholder="you@example.com"`) +
    `<div class="field${errors.message ? " bad" : ""}"><label class="lbl" for="message">${FIELD_LABELS.message}${reqMark(false)}</label>` +
    `<textarea id="message" name="message" maxlength="${LP_SPONSOR_MESSAGE_MAX}" placeholder="ご質問やご希望のプランなど（任意）"${msgAria}>` +
    `${escapeHtml(values.message ?? "")}</textarea>${errMsg(errors, "message")}</div>` +
    `<div class="hp" aria-hidden="true"><label>空欄のままにしてください<input type="text" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></label></div>` +
    `<p class="note">${USAGE_NOTE}</p>` +
    '<button class="submit" type="submit">資料を請求する<span class="ar" aria-hidden="true">→</span></button>' +
    "</section></form>";
  return shell("スポンサー募集", top + `<div class="body"><div class="wrap">${form}</div></div>`, !!o.demo, false, DEMO_NOTE);
}

export function renderSponsorThanksPage(o: { demo?: boolean }): string {
  return shell(
    "スポンサー資料のご請求",
    hero({ title: 'Thank <span class="g">you!</span>', ghost: "THANKS", eyebrow: "SPONSORSHIP", step: 2, steps: STEPS, small: true }) +
      '<div class="body"><div class="wrap"><section class="card done rv">' +
      '<div class="ico pop"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="ck" d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>' +
      "<h2>資料のご請求ありがとうございました</h2>" +
      '<p class="lead">受付完了のメールをお送りしました。スポンサーチームの担当者より、ご入力のメールアドレス宛てに資料をお送りします。</p>' +
      '<div class="acts"><a class="btn1" href="/">トップへ戻る</a></div>' +
      "</section></div></div>",
    !!o.demo,
    false,
    DEMO_NOTE,
  );
}

// ---------- LP page injection ----------

export const SPONSOR_CTA_LABEL = "資料を請求する";
/** LP JOIN スポンサー card (v3.6+). Older versions have no sponsor card: the script finds nothing. */
export const SPONSOR_CTA_SELECTOR = ".svc-card--sponsor .svc-card-link";

// Keyed on [data-lp-so], which only the script sets: with JS off nothing changes.
const SPONSOR_CSS =
  "[data-lp-so]{cursor:pointer!important}" +
  "[data-lp-so] .svc-card-badge,[data-lp-so] .svc-card-soon{display:none!important}" +
  ".svc-card-link[data-lp-so] .svc-card-cta--disabled{color:var(--lp-blue-deep,#1e3fa8)!important;gap:.5rem}" +
  `.svc-card-link[data-lp-so] .svc-card-cta--disabled::before{content:"${SPONSOR_CTA_LABEL}"}` +
  '.svc-card-link[data-lp-so] .svc-card-cta--disabled::after{content:"\\2192";display:inline-grid;place-items:center;' +
  "width:2em;height:2em;border-radius:50%;font-size:.82em;line-height:1;background:var(--lp-blue,#2f61d6);color:#fff;" +
  "transition:transform .24s cubic-bezier(.22,1,.36,1)}" +
  ".svc-card-link[data-lp-so]:hover .svc-card-cta--disabled::after{transform:translateX(5px)}" +
  "@media (prefers-reduced-motion:reduce){[data-lp-so],[data-lp-so] *::after{transition:none!important}}";

/** In-place swap of the LP's スポンサー card from 準備中 to a link to /sponsors. */
export function sponsorsCtaSwap(): string {
  const script = ctaSwapScript({ attr: "data-lp-so", label: SPONSOR_CTA_LABEL, href: "/sponsors", selector: SPONSOR_CTA_SELECTOR });
  return `<style id="lp-sponsors-cta-css">${SPONSOR_CSS}</style><script id="lp-sponsors-cta-swap">${script}</script>`;
}

/** HTML appended to LP pages while the sponsor page is public. */
export function sponsorsInjection(cfg: SponsorConfig | null): string {
  return cfg && cfg.enabled ? sponsorsCtaSwap() : "";
}

// ---------- handler ----------

/** Sender key for lp-analytics' per-sender cap (10 / hour). */
export function sponsorClientKeyFor(req: Request): Promise<string | null> {
  return senderKeyFor(req, "lp-sponsors");
}

export interface SponsorsDeps {
  demo: boolean;
  /** Sponsor config, or null when unavailable (treated as flag off). */
  getConfig(): Promise<SponsorConfig | null>;
  /** Calls lp-analytics (path like "/lp/internal/sponsor-inquiries/submit"); null when no binding. */
  internal: ((path: string, init: RequestInit) => Promise<Response>) | null;
}

/**
 * Handles /sponsors*. Returns null when the request is not a sponsors route, or the page is not public —
 * the caller then serves the normal version 404.
 */
export async function handleSponsors(req: Request, deps: SponsorsDeps): Promise<Response | null> {
  const url = new URL(req.url);
  const route = matchSponsorsRoute(url.pathname);
  if (!route) return null;
  const config = await deps.getConfig();
  if (!config || !config.enabled) return null;

  if (route === "page" || route === "thanks") {
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    return htmlResponse(route === "page" ? renderSponsorsPage({ demo: deps.demo }) : renderSponsorThanksPage({ demo: deps.demo }));
  }

  if (req.method !== "POST") return redirect("/sponsors");
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return new Response("Forbidden", { status: 403, headers: BASE_HEADERS });
  const text = await req.text();
  if (text.length > BODY_MAX) return new Response("Payload Too Large", { status: 413, headers: BASE_HEADERS });
  const parsed = parseSponsorForm(new URLSearchParams(text));
  const page = (errors: FormErrors, status: number) =>
    htmlResponse(renderSponsorsPage({ values: parsed.values, errors, demo: deps.demo }), status);
  if (!parsed.ok) {
    // Honeypot: look successful so bots learn nothing, store / notify nothing.
    if (parsed.spam) return redirect("/sponsors/thanks");
    return page(parsed.errors, 400);
  }
  if (deps.demo) return redirect("/sponsors/thanks");
  if (!deps.internal) return page(mapSponsorSubmitError(503, null), 503);

  let res: Response;
  try {
    res = await deps.internal("/lp/internal/sponsor-inquiries/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...parsed.input, clientKey: await sponsorClientKeyFor(req) }),
    });
  } catch {
    return page(mapSponsorSubmitError(502, null), 502);
  }
  if (res.ok) return redirect("/sponsors/thanks");
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return page(mapSponsorSubmitError(res.status, body), res.status >= 400 && res.status < 600 ? res.status : 502);
}
