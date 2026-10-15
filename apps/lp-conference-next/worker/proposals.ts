// Public speaker call page (/proposals*) for the LP Worker. Version-independent and gated by the
// proposals flag served by lp-analytics (GET /lp/internal/proposals). Same look and form
// vocabulary as /tickets (shared helpers in ./tickets.ts).
// Pure logic + a dependency-injected handler: no runtime imports, so it runs under both
// workerd and `node --test` (strip-only TS: no enums / parameter properties).
import {
  BASE_HEADERS,
  CHECKBOX_YES,
  HONEYPOT,
  ctaSwapScript,
  errMsg,
  escapeHtml,
  hero,
  htmlResponse,
  redirect,
  renderField,
  reqMark,
  senderKeyFor,
  shell,
  type FormErrors,
  type FormValues,
  type TicketField,
} from "./tickets.ts";

export interface ProposalConfig {
  enabled: boolean;
  /** Set by the Worker (previewProposals), never by lp-analytics: shown as open, never accepts. */
  preview: boolean;
  fields: TicketField[];
}

export interface ProposalInput {
  name: string;
  email: string;
  title: string;
  abstract: string;
  answers: Record<string, string>;
}

const NAME_MAX = 100;
const EMAIL_MAX = 254;
export const TITLE_MAX = 100;
export const ABSTRACT_MAX = 2000;
const TEXT_MAX = 200;
const TEXTAREA_MAX = 2000;
const BODY_MAX = 32 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STEPS = ["応募内容の入力", "事務局で選考", "結果のご連絡"];
const DEMO_NOTE = "デモ環境です（応募内容は保存されません）";
export const PROPOSAL_PREVIEW_NOTE = "プレビュー表示中です。このページはまだ一般公開されていません（応募はできません）。";
export const USAGE_NOTE = "ご入力いただいた情報は、登壇者の選考とご連絡にのみ使用します。";

export const DEMO_PROPOSAL_CONFIG: ProposalConfig = {
  enabled: true,
  preview: false,
  fields: [
    { id: "format", label: "発表形式", type: "select", required: true, options: ["セッション（30分）", "LT（5分）"] },
    { id: "affiliation", label: "所属", type: "text", required: false, options: [] },
    { id: "bio", label: "自己紹介", type: "textarea", required: false, options: [] },
  ],
};

export function matchProposalsRoute(pathname: string): "page" | "submit" | "thanks" | null {
  const p = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (p === "/proposals") return "page";
  if (p === "/proposals/submit") return "submit";
  if (p === "/proposals/thanks") return "thanks";
  return null;
}

export function isProposalsPath(pathname: string): boolean {
  return pathname === "/proposals" || pathname.startsWith("/proposals/");
}

/** Validates the internal config payload; null when malformed. */
export function parseProposalConfig(raw: unknown): ProposalConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.enabled !== "boolean" || !Array.isArray(o.fields)) return null;
  const fields: TicketField[] = [];
  for (const f of o.fields) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.label !== "string") continue;
    const type = r.type === "textarea" || r.type === "select" || r.type === "checkbox" ? r.type : "text";
    const options = Array.isArray(r.options) ? r.options.filter((x): x is string => typeof x === "string") : [];
    fields.push({ id: r.id, label: r.label, type, required: r.required === true, options });
  }
  return { enabled: o.enabled, preview: false, fields };
}

/**
 * LP管理「プレビュー」タブの指定 (?proposals=on|off) を、この閲覧者にだけ当てる。
 * on: 募集停止中でも募集中の見た目 (preview: true = 応募不可)。off: 募集中でも出さない。
 */
export function previewProposals(cfg: ProposalConfig | null, mode: "on" | "off" | null): ProposalConfig | null {
  if (!cfg || !mode) return cfg;
  if (mode === "on" && !cfg.enabled) return { ...cfg, enabled: true, preview: true };
  if (mode === "off" && cfg.enabled) return { ...cfg, enabled: false };
  return cfg;
}

// ---------- form parsing / validation ----------

export type ProposalParseResult =
  | { ok: true; input: ProposalInput; values: FormValues }
  | { ok: false; spam: boolean; values: FormValues; errors: FormErrors };

export function parseProposalForm(form: URLSearchParams, config: ProposalConfig): ProposalParseResult {
  const values: FormValues = {};
  const errors: FormErrors = {};
  const get = (k: string): string => (form.get(k) ?? "").trim();
  if (get(HONEYPOT)) return { ok: false, spam: true, values, errors };

  const fixed = (k: "name" | "email" | "title" | "abstract", label: string, max: number): string => {
    const v = get(k);
    values[k] = v;
    if (!v) errors[k] = `${label}を入力してください`;
    else if (v.length > max) errors[k] = `${label}は${max}文字以内で入力してください`;
    return v;
  };
  const title = fixed("title", "発表タイトル", TITLE_MAX);
  const abstract = fixed("abstract", "発表の概要", ABSTRACT_MAX);
  const name = fixed("name", "氏名", NAME_MAX);
  const email = fixed("email", "メールアドレス", EMAIL_MAX);
  if (email && !errors.email && !EMAIL_RE.test(email)) errors.email = "メールアドレスの形式が正しくありません";

  const answers: Record<string, string> = {};
  for (const f of config.fields) {
    const key = `f_${f.id}`;
    const v = get(key);
    values[key] = v;
    if (f.required && !v) errors[key] = f.type === "checkbox" ? "チェックを入れてください" : `${f.label}を入力してください`;
    else if ((f.type === "text" && v.length > TEXT_MAX) || (f.type === "textarea" && v.length > TEXTAREA_MAX)) {
      errors[key] = `${f.label}が長すぎます`;
    } else if (v && f.type === "select" && !f.options.includes(v)) errors[key] = `${f.label}を選び直してください`;
    else if (v && f.type === "checkbox" && v !== CHECKBOX_YES) errors[key] = `${f.label}を確認してください`;
    answers[f.id] = v;
  }
  if (Object.keys(errors).length > 0) return { ok: false, spam: false, values, errors };
  return { ok: true, input: { name, email, title, abstract, answers }, values };
}

/** lp-analytics error → inline errors (400 per-field reasons, 404 closed, 429 cap, else generic). */
export function mapSubmitError(status: number, body: unknown, config: ProposalConfig): FormErrors {
  if (status === 400) {
    const details = (body as { error?: { details?: unknown } } | null)?.error?.details;
    const out: FormErrors = {};
    if (Array.isArray(details)) {
      const ids = new Set(config.fields.map((f) => f.id));
      for (const d of details) {
        const field = typeof d?.field === "string" ? (d.field as string) : "";
        if (field === "name" || field === "email" || field === "title" || field === "abstract") {
          out[field] = "入力内容を確認してください";
        } else if (field.startsWith("answers.") && ids.has(field.slice(8))) {
          out[`f_${field.slice(8)}`] = "入力内容を確認してください";
        }
      }
    }
    out._form = "入力内容を確認してください。";
    return out;
  }
  if (status === 404) return { _form: "現在、登壇者の募集は行っていません。" };
  if (status === 429) {
    return { _form: "短い時間に多くの応募があったため受け付けられませんでした。時間をおいてもう一度お試しください。" };
  }
  return { _form: "送信できませんでした。時間をおいてもう一度お試しください。" };
}

// ---------- rendering ----------

function textInput(
  key: "name" | "email" | "title",
  label: string,
  values: FormValues,
  errors: FormErrors,
  attrs: string,
): string {
  const aria = errors[key] ? ` aria-invalid="true" aria-describedby="${key}-err"` : "";
  return (
    `<div class="field${errors[key] ? " bad" : ""}"><label class="lbl" for="${key}">${label}${reqMark(true)}</label>` +
    `<input ${attrs} id="${key}" name="${key}" value="${escapeHtml(values[key] ?? "")}" required${aria}>${errMsg(errors, key)}</div>`
  );
}

function abstractInput(values: FormValues, errors: FormErrors): string {
  const aria = errors.abstract ? ' aria-invalid="true" aria-describedby="abstract-err"' : "";
  return (
    `<div class="field${errors.abstract ? " bad" : ""}"><label class="lbl" for="abstract">発表の概要${reqMark(true)}</label>` +
    `<textarea id="abstract" name="abstract" maxlength="${ABSTRACT_MAX}" placeholder="どんな話をするか、聞いた人が何を持ち帰れるかを書いてください" required${aria}>` +
    `${escapeHtml(values.abstract ?? "")}</textarea>${errMsg(errors, "abstract")}</div>`
  );
}

export interface ProposalsPageOptions {
  config: ProposalConfig;
  values?: FormValues;
  errors?: FormErrors;
  demo?: boolean;
}

export function renderProposalsPage(o: ProposalsPageOptions): string {
  const { config } = o;
  const values = o.values ?? {};
  const errors = o.errors ?? {};
  const top = hero({
    title: '登壇者<span class="g">募集</span>',
    sub: "北陸ITカンファレンスで話してみませんか。発表したい内容をお送りください。",
    ghost: "SPEAKERS",
    eyebrow: "CALL FOR PROPOSALS",
    step: 1,
    steps: STEPS,
  });
  const alerts = errors._form ? `<div class="alert err" role="alert">${escapeHtml(errors._form)}</div>` : "";
  const extra = config.fields.map((f) => renderField(f, values, errors)).join("");
  const form =
    `<form class="buy" method="post" action="/proposals/submit" novalidate data-lp-proposals-form>` +
    alerts +
    '<section class="card rv"><div class="shead"><span class="no">01</span><h2>発表の内容</h2><p>選考に使います</p></div>' +
    textInput("title", "発表タイトル", values, errors, `type="text" maxlength="${TITLE_MAX}" placeholder="例: 1 つの Worker で LP の全版を配信する"`) +
    abstractInput(values, errors) +
    extra +
    "</section>" +
    '<section class="card rv"><div class="shead"><span class="no">02</span><h2>登壇者情報</h2><p>選考結果をメールでお知らせします</p></div>' +
    `<div class="two">${textInput("name", "氏名", values, errors, `type="text" autocomplete="name" maxlength="${NAME_MAX}" placeholder="北陸 太郎"`)}` +
    `${textInput("email", "メールアドレス", values, errors, `type="email" autocomplete="email" maxlength="${EMAIL_MAX}" placeholder="you@example.com"`)}</div>` +
    `<div class="hp" aria-hidden="true"><label>空欄のままにしてください<input type="text" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></label></div>` +
    `<p class="note">${USAGE_NOTE}</p>` +
    '<button class="submit" type="submit">この内容で応募する<span class="ar" aria-hidden="true">→</span></button>' +
    "</section></form>";
  return shell(
    "登壇者募集",
    top + `<div class="body"><div class="wrap">${form}</div></div>`,
    !!o.demo,
    config.preview,
    DEMO_NOTE,
    PROPOSAL_PREVIEW_NOTE,
  );
}

export function renderProposalThanksPage(o: { demo?: boolean }): string {
  return shell(
    "登壇応募",
    hero({ title: 'Thank <span class="g">you!</span>', ghost: "THANKS", eyebrow: "CALL FOR PROPOSALS", step: 2, steps: STEPS, small: true }) +
      '<div class="body"><div class="wrap"><section class="card done rv">' +
      '<div class="ico pop"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="ck" d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>' +
      "<h2>ご応募ありがとうございました</h2>" +
      '<p class="lead">内容を拝見し、選考結果はご登録のメールアドレスにお知らせします。</p>' +
      '<div class="acts"><a class="btn1" href="/">トップへ戻る</a></div></section></div></div>',
    !!o.demo,
    false,
    DEMO_NOTE,
  );
}

// ---------- LP page injection ----------

export const SPEAKER_CTA_LABEL = "登壇に応募する";
/** LP 登壇応募 buttons (same markup in v3.4 / v3.5): hero pill + speaker service card. */
export const SPEAKER_CTA_SELECTOR = ".hero-cta--speaker,.svc-card--speaker .svc-card-link";

// Keyed on [data-lp-sp], which only the script sets: with JS off nothing changes.
const SPEAKER_CSS =
  "[data-lp-sp]{cursor:pointer!important}" +
  "[data-lp-sp] .hero-cta-badge,[data-lp-sp] .svc-card-badge,[data-lp-sp] .svc-card-soon{display:none!important}" +
  ".svc-card-link[data-lp-sp] .svc-card-cta--disabled{color:var(--lp-blue-deep,#1e3fa8)!important;gap:.5rem}" +
  `.svc-card-link[data-lp-sp] .svc-card-cta--disabled::before{content:"${SPEAKER_CTA_LABEL}"}` +
  '.svc-card-link[data-lp-sp] .svc-card-cta--disabled::after{content:"\\2192";display:inline-grid;place-items:center;' +
  "width:2em;height:2em;border-radius:50%;font-size:.82em;line-height:1;background:var(--lp-blue,#2f61d6);color:#fff;" +
  "transition:transform .24s cubic-bezier(.22,1,.36,1)}" +
  ".svc-card-link[data-lp-sp]:hover .svc-card-cta--disabled::after{transform:translateX(5px)}" +
  "@media (prefers-reduced-motion:reduce){[data-lp-sp],[data-lp-sp] *::after{transition:none!important}}";

/** In-place swap of the LP's 登壇に応募する buttons from 準備中 to a link to /proposals. */
export function proposalsCtaSwap(): string {
  const script = ctaSwapScript({
    attr: "data-lp-sp",
    label: SPEAKER_CTA_LABEL,
    href: "/proposals",
    selector: SPEAKER_CTA_SELECTOR,
  });
  return `<style id="lp-proposals-cta-css">${SPEAKER_CSS}</style><script id="lp-proposals-cta-swap">${script}</script>`;
}

/** HTML appended to LP pages while proposals are open (or previewed as open). */
export function proposalsInjection(cfg: ProposalConfig | null): string {
  return cfg && cfg.enabled ? proposalsCtaSwap() : "";
}

// ---------- handler ----------

/** Sender key for lp-analytics' per-sender daily cap (see senderKeyFor). */
export function clientKeyFor(req: Request): Promise<string | null> {
  return senderKeyFor(req, "lp-proposals");
}

export interface ProposalsDeps {
  demo: boolean;
  /** Proposals config, or null when unavailable (treated as flag off). */
  getConfig(): Promise<ProposalConfig | null>;
  /** Calls lp-analytics (path like "/lp/internal/proposals/submit"); null when no binding. */
  internal: ((path: string, init: RequestInit) => Promise<Response>) | null;
}

/**
 * Handles /proposals*. Returns null when the request is not a proposals route, or the feature is
 * off / unavailable — the caller then serves the normal version 404.
 */
export async function handleProposals(req: Request, deps: ProposalsDeps): Promise<Response | null> {
  const url = new URL(req.url);
  const route = matchProposalsRoute(url.pathname);
  if (!route) return null;
  const config = await deps.getConfig();
  if (!config || !config.enabled) return null;

  if (route === "page") {
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    return htmlResponse(renderProposalsPage({ config, demo: deps.demo }));
  }
  if (route === "thanks") {
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    return htmlResponse(renderProposalThanksPage({ demo: deps.demo }));
  }

  // route === "submit"
  if (req.method !== "POST") return redirect("/proposals");
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return new Response("Forbidden", { status: 403, headers: BASE_HEADERS });
  const text = await req.text();
  if (text.length > BODY_MAX) return new Response("Payload Too Large", { status: 413, headers: BASE_HEADERS });
  const parsed = parseProposalForm(new URLSearchParams(text), config);
  const page = (errors: FormErrors, status: number) =>
    htmlResponse(renderProposalsPage({ config, values: parsed.values, errors, demo: deps.demo }), status);
  if (!parsed.ok) {
    if (parsed.spam) return redirect("/proposals/thanks");
    return page(parsed.errors, 400);
  }
  if (config.preview) return page({ _form: "プレビュー表示中のため、応募はできません。" }, 403);
  if (deps.demo) return redirect("/proposals/thanks");
  if (!deps.internal) return page(mapSubmitError(503, null, config), 503);

  let res: Response;
  try {
    res = await deps.internal("/lp/internal/proposals/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...parsed.input, clientKey: await clientKeyFor(req) }),
    });
  } catch {
    return page(mapSubmitError(502, null, config), 502);
  }
  if (res.ok) return redirect("/proposals/thanks");
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return page(mapSubmitError(res.status, body, config), res.status >= 400 && res.status < 600 ? res.status : 502);
}
