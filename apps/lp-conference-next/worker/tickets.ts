// Public ticket purchase page (/tickets*) for the LP Worker. Version-independent and gated by
// the tickets feature flag served by lp-analytics (GET /lp/internal/tickets).
// Pure logic + a dependency-injected handler: no runtime imports, so it runs under both
// workerd and `node --test` (strip-only TS: no enums / parameter properties).

export type TicketFieldType = "text" | "textarea" | "select" | "checkbox";
export interface TicketField {
  id: string;
  label: string;
  type: TicketFieldType;
  required: boolean;
  options: string[];
}
export interface PublicTicketType {
  id: string;
  name: string;
  description: string;
  priceJpy: number;
  soldOut: boolean;
}
export interface TicketConfig {
  enabled: boolean;
  paymentReady: boolean;
  fields: TicketField[];
  types: PublicTicketType[];
}

export interface CheckoutInput {
  ticketTypeId: string;
  name: string;
  email: string;
  answers: Record<string, string>;
}

/** Form values keyed by input name (ticketType / name / email / f_<fieldId>). */
export type FormValues = Record<string, string>;
/** Inline errors keyed by input name; "_form" = message above the form. */
export type FormErrors = Record<string, string>;

export const HONEYPOT = "website";
export const CHECKBOX_YES = "はい";
const NAME_MAX = 100;
const EMAIL_MAX = 254;
const TEXT_MAX = 200;
const TEXTAREA_MAX = 2000;
const BODY_MAX = 32 * 1024;

export const DEMO_CONFIG: TicketConfig = {
  enabled: true,
  paymentReady: true,
  fields: [
    { id: "affiliation", label: "所属", type: "text", required: false, options: [] },
    { id: "attendance", label: "参加区分", type: "select", required: true, options: ["現地", "オンライン"] },
  ],
  types: [
    { id: "demo-general", name: "一般", description: "一般参加チケット（全セッション参加可）", priceJpy: 3000, soldOut: false },
    { id: "demo-student", name: "学生", description: "学生の方向け（当日学生証をご提示ください）", priceJpy: 1000, soldOut: false },
    { id: "demo-invite", name: "招待", description: "招待コードをお持ちの方", priceJpy: 0, soldOut: false },
    { id: "demo-early", name: "早割", description: "早期購入割引（数量限定）", priceJpy: 2000, soldOut: true },
  ],
};

// ---------- helpers ----------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatPrice(priceJpy: number): string {
  if (priceJpy <= 0) return "無料";
  return "¥" + String(Math.trunc(priceJpy)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function fieldInputName(fieldId: string): string {
  return `f_${fieldId}`;
}

export function isSelectable(t: PublicTicketType, paymentReady: boolean): boolean {
  return !t.soldOut && (t.priceJpy <= 0 || paymentReady);
}

/** Maps a request path to a tickets route, or null when it is not a tickets path. */
export function matchTicketsRoute(pathname: string): "page" | "checkout" | "thanks" | "webhook" | null {
  const p = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (p === "/tickets") return "page";
  if (p === "/tickets/checkout") return "checkout";
  if (p === "/tickets/thanks") return "thanks";
  if (p === "/tickets/stripe-webhook") return "webhook";
  return null;
}

export function isTicketsPath(pathname: string): boolean {
  return pathname === "/tickets" || pathname.startsWith("/tickets/");
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Validates the internal config payload; null when malformed. */
export function parseConfig(raw: unknown): TicketConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.enabled !== "boolean" || !Array.isArray(o.types) || !Array.isArray(o.fields)) return null;
  const types: PublicTicketType[] = [];
  for (const t of o.types) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.priceJpy !== "number") continue;
    types.push({ id: r.id, name: r.name, description: str(r.description), priceJpy: r.priceJpy, soldOut: r.soldOut === true });
  }
  const fields: TicketField[] = [];
  for (const f of o.fields) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.label !== "string") continue;
    const type = r.type === "textarea" || r.type === "select" || r.type === "checkbox" ? r.type : "text";
    const options = Array.isArray(r.options) ? r.options.filter((x): x is string => typeof x === "string") : [];
    fields.push({ id: r.id, label: r.label, type, required: r.required === true, options });
  }
  return { enabled: o.enabled, paymentReady: o.paymentReady === true, fields, types };
}

// ---------- form parsing / validation ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ParseResult =
  | { ok: true; input: CheckoutInput; values: FormValues }
  | { ok: false; spam: boolean; values: FormValues; errors: FormErrors };

export function parseCheckoutForm(form: URLSearchParams, config: TicketConfig): ParseResult {
  const values: FormValues = {
    ticketType: (form.get("ticketType") ?? "").trim(),
    name: (form.get("name") ?? "").trim(),
    email: (form.get("email") ?? "").trim(),
  };
  for (const f of config.fields) {
    const key = fieldInputName(f.id);
    values[key] = (form.get(key) ?? "").trim();
  }
  if ((form.get(HONEYPOT) ?? "") !== "") return { ok: false, spam: true, values, errors: {} };

  const errors: FormErrors = {};
  const type = config.types.find((t) => t.id === values.ticketType);
  if (!type) errors.ticketType = "券種を選択してください";
  else if (type.soldOut) errors.ticketType = "この券種は売り切れました";
  else if (!isSelectable(type, config.paymentReady)) errors.ticketType = "この券種は現在お申し込みいただけません";

  if (!values.name) errors.name = "氏名を入力してください";
  else if (values.name.length > NAME_MAX) errors.name = `氏名は${NAME_MAX}文字以内で入力してください`;
  if (!values.email) errors.email = "メールアドレスを入力してください";
  else if (values.email.length > EMAIL_MAX || !EMAIL_RE.test(values.email)) errors.email = "メールアドレスの形式が正しくありません";

  const answers: Record<string, string> = {};
  for (const f of config.fields) {
    const key = fieldInputName(f.id);
    let v = values[key];
    if (f.type === "checkbox") {
      v = v ? CHECKBOX_YES : "";
      values[key] = v;
    }
    if (f.required && !v) {
      errors[key] = f.type === "checkbox" ? "チェックしてください" : f.type === "select" ? "選択してください" : "入力してください";
    } else if (f.type === "select" && v && !f.options.includes(v)) {
      errors[key] = "選択肢から選んでください";
    } else if ((f.type === "text" && v.length > TEXT_MAX) || (f.type === "textarea" && v.length > TEXTAREA_MAX)) {
      errors[key] = `${f.type === "text" ? TEXT_MAX : TEXTAREA_MAX}文字以内で入力してください`;
    }
    answers[f.id] = v;
  }
  if (Object.keys(errors).length > 0) return { ok: false, spam: false, values, errors };
  return { ok: true, values, input: { ticketTypeId: values.ticketType, name: values.name, email: values.email, answers } };
}

/** Maps a lp-analytics checkout error to inline errors / a form-level message. */
export function mapCheckoutError(status: number, body: unknown, config: TicketConfig): FormErrors {
  const errors: FormErrors = {};
  if (status === 400) {
    // Wire shape is ErrorResponse = { error: { code, message, details } } (@dub/errors).
    const err = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    const details = err && typeof err === "object" ? (err as { details?: unknown }).details : undefined;
    if (Array.isArray(details)) {
      const ids = new Set(config.fields.map((f) => f.id));
      for (const d of details) {
        const field = d && typeof d === "object" ? str((d as { field?: unknown }).field) : "";
        const key = detailKey(field, ids);
        if (key) errors[key] = errors[key] ?? "入力内容を確認してください";
      }
    }
    errors._form = "入力内容に誤りがあります。各項目をご確認ください。";
  } else if (status === 409) {
    errors.ticketType = "この券種は売り切れました";
    errors._form = "選択された券種は売り切れました。別の券種をお選びください。";
  } else if (status === 429) {
    errors._form = "ただいまお申し込みが集中しています。しばらく時間をおいて再度お試しください。";
  } else if (status === 503) {
    errors._form = "現在、決済の準備中です。有料チケットはしばらくお待ちください。";
  } else {
    errors._form = "お申し込みを処理できませんでした。時間をおいて再度お試しください。";
  }
  return errors;
}

function detailKey(field: string, ids: Set<string>): string | null {
  if (field === "ticketTypeId" || field === "ticketType") return "ticketType";
  if (field === "name" || field === "email") return field;
  const id = field.startsWith("answers.") ? field.slice("answers.".length) : field;
  return ids.has(id) ? fieldInputName(id) : null;
}

// ---------- rendering ----------

const FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Zen+Kaku+Gothic+New:wght@400;500;700;900&display=swap";

const STYLE = `
:root{--h:#101ca8;--ink:#24272e;--soft:#4b5563;--mute:#6b7280;--blue:#2f61d6;--btn:#2a5fd0;--link:#1a5fb8;
--alt:#f6f9fe;--bd:rgba(16,28,168,.10);--err:#b42318;--errbg:#fef3f2;--ok:#17805c;
--sh:0 6px 16px -4px rgba(16,42,100,.12),0 2px 6px -2px rgba(16,42,100,.08);--r:14px;
--font:"Inter","Zen Kaku Gothic New","Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,-apple-system,sans-serif}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:var(--font);color:var(--ink);background:linear-gradient(180deg,#e8f6fe 0%,#f6f9fe 280px,#fff 100%);line-height:1.7;-webkit-font-smoothing:antialiased}
a{color:var(--link)}
:where(a,button,input,select,textarea):focus-visible{outline:3px solid rgba(47,97,214,.45);outline-offset:2px}
.demo{background:#fff4d6;color:#7a4b00;text-align:center;font-size:13px;font-weight:600;padding:6px 16px}
.top{max-width:760px;margin:0 auto;padding:24px 20px 0;display:flex;justify-content:space-between;align-items:center;gap:16px}
.brand{font-weight:900;color:var(--h);text-decoration:none;font-size:17px;letter-spacing:.02em}
.back{font-size:14px;color:var(--soft)}
main{max-width:760px;margin:0 auto;padding:24px 20px 64px}
h1{color:var(--h);font-size:28px;line-height:1.35;margin:8px 0 8px;font-weight:900}
.lead{color:var(--soft);margin:0 0 28px}
.panel{background:#fff;border:1px solid var(--bd);border-radius:20px;box-shadow:var(--sh);padding:28px}
.alert{border-radius:var(--r);padding:12px 16px;margin:0 0 24px;font-weight:600;font-size:15px}
.alert.err{background:var(--errbg);color:var(--err);border:1px solid #fecdca}
.alert.info{background:var(--alt);color:var(--h);border:1px solid var(--bd)}
fieldset{border:0;margin:0 0 28px;padding:0}
legend,.lbl{display:block;font-weight:700;color:var(--ink);margin:0 0 10px;font-size:15px}
.req{color:var(--err);font-size:12px;font-weight:700;margin-left:6px}
.opt{color:var(--mute);font-size:12px;font-weight:600;margin-left:6px}
.types{display:grid;gap:12px}
.type{display:flex;gap:14px;align-items:flex-start;border:1.5px solid var(--bd);border-radius:var(--r);padding:16px 18px;background:#fff;cursor:pointer;transition:border-color .15s,box-shadow .15s}
.type:hover{border-color:var(--blue)}
.type:has(input:checked){border-color:var(--blue);box-shadow:0 0 0 3px rgba(47,97,214,.15);background:var(--alt)}
.type.off{cursor:not-allowed;opacity:.55;background:#f9fafb}
.type.off:hover{border-color:var(--bd)}
.type input{margin-top:5px;accent-color:var(--btn);width:18px;height:18px;flex:none}
.tbody{flex:1;min-width:0}
.trow{display:flex;justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap}
.tname{font-weight:700;font-size:16px}
.price{font-weight:800;color:var(--h);font-size:18px}
.tdesc{color:var(--soft);font-size:14px;margin:4px 0 0}
.badge{display:inline-block;font-size:12px;font-weight:700;border-radius:999px;padding:2px 10px;margin-left:8px;background:#eceef2;color:var(--soft)}
.field{margin:0 0 22px}
input[type=text],input[type=email],select,textarea{width:100%;font:inherit;font-size:16px;color:var(--ink);background:#fff;border:1.5px solid #d5dae3;border-radius:10px;padding:11px 14px}
textarea{min-height:110px;resize:vertical}
input:focus,select:focus,textarea:focus{border-color:var(--blue);outline:none;box-shadow:0 0 0 3px rgba(47,97,214,.15)}
.bad input[type=text],.bad input[type=email],.bad select,.bad textarea{border-color:var(--err)}
.msg{color:var(--err);font-size:13px;font-weight:600;margin:6px 0 0}
.check{display:flex;gap:10px;align-items:center;font-weight:500}
.check input{width:18px;height:18px;accent-color:var(--btn)}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
.note{color:var(--mute);font-size:13px;margin:4px 0 20px}
.submit{display:block;width:100%;border:0;border-radius:999px;padding:15px 24px;font:inherit;font-size:17px;font-weight:800;color:#fff;background:linear-gradient(120deg,var(--btn) 0%,#2b78bd 100%);box-shadow:0 12px 26px -6px rgba(47,97,214,.42);cursor:pointer}
.submit:hover{filter:brightness(1.06)}
.done{text-align:center;padding:40px 28px}
.done h1{font-size:24px}
.done .tn{font-weight:700;font-size:18px;color:var(--ink);margin:4px 0 16px}
.btn2{display:inline-block;margin-top:16px;border:1.5px solid var(--btn);color:var(--btn);border-radius:999px;padding:10px 24px;font-weight:700;text-decoration:none}
footer{text-align:center;color:var(--mute);font-size:12px;padding:0 20px 32px}
@media (max-width:560px){.panel{padding:20px}h1{font-size:23px}}
`;

const CONF_NAME = "北陸ITカンファレンス 2027";

function shell(title: string, body: string, demo: boolean): string {
  return (
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    `<title>${escapeHtml(title)}｜${CONF_NAME}</title>` +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    `<link rel="stylesheet" href="${FONT_HREF}">` +
    `<style>${STYLE}</style></head><body>` +
    (demo ? '<div class="demo" role="note">デモ環境です（実際の決済は行われません）</div>' : "") +
    `<header class="top"><a class="brand" href="/">${CONF_NAME}</a><a class="back" href="/">トップへ戻る</a></header>` +
    `<main>${body}</main>` +
    `<footer>&copy; ${CONF_NAME}</footer></body></html>`
  );
}

function errMsg(errors: FormErrors, key: string): string {
  const m = errors[key];
  return m ? `<p class="msg" id="${escapeHtml(key)}-err">${escapeHtml(m)}</p>` : "";
}

function reqMark(required: boolean): string {
  return required ? '<span class="req">必須</span>' : '<span class="opt">任意</span>';
}

function renderType(t: PublicTicketType, paymentReady: boolean, checked: boolean): string {
  const selectable = isSelectable(t, paymentReady);
  const badge = t.soldOut ? "売り切れ" : !selectable ? "決済準備中" : "";
  return (
    `<label class="type${selectable ? "" : " off"}">` +
    `<input type="radio" name="ticketType" value="${escapeHtml(t.id)}"${checked && selectable ? " checked" : ""}${selectable ? "" : " disabled"} required>` +
    '<span class="tbody"><span class="trow">' +
    `<span class="tname">${escapeHtml(t.name)}${badge ? `<span class="badge">${badge}</span>` : ""}</span>` +
    `<span class="price">${escapeHtml(formatPrice(t.priceJpy))}</span></span>` +
    (t.description ? `<p class="tdesc">${escapeHtml(t.description)}</p>` : "") +
    "</span></label>"
  );
}

function renderField(f: TicketField, values: FormValues, errors: FormErrors): string {
  const key = fieldInputName(f.id);
  const k = escapeHtml(key);
  const v = values[key] ?? "";
  const bad = errors[key] ? " bad" : "";
  const aria = errors[key] ? ` aria-invalid="true" aria-describedby="${k}-err"` : "";
  const req = f.required ? " required" : "";
  if (f.type === "checkbox") {
    return (
      `<div class="field${bad}"><label class="check"><input type="checkbox" name="${k}" value="${CHECKBOX_YES}"` +
      `${v ? " checked" : ""}${req}${aria}>${escapeHtml(f.label)}${reqMark(f.required)}</label>${errMsg(errors, key)}</div>`
    );
  }
  let control: string;
  if (f.type === "textarea") {
    control = `<textarea id="${k}" name="${k}" maxlength="${TEXTAREA_MAX}"${req}${aria}>${escapeHtml(v)}</textarea>`;
  } else if (f.type === "select") {
    const opts = f.options
      .map((o) => `<option value="${escapeHtml(o)}"${o === v ? " selected" : ""}>${escapeHtml(o)}</option>`)
      .join("");
    control = `<select id="${k}" name="${k}"${req}${aria}><option value="">選択してください</option>${opts}</select>`;
  } else {
    control = `<input type="text" id="${k}" name="${k}" value="${escapeHtml(v)}" maxlength="${TEXT_MAX}"${req}${aria}>`;
  }
  return `<div class="field${bad}"><label class="lbl" for="${k}">${escapeHtml(f.label)}${reqMark(f.required)}</label>${control}${errMsg(errors, key)}</div>`;
}

function fixedField(key: "name" | "email", label: string, values: FormValues, errors: FormErrors): string {
  const aria = errors[key] ? ` aria-invalid="true" aria-describedby="${key}-err"` : "";
  const attrs = key === "email" ? `type="email" autocomplete="email" maxlength="${EMAIL_MAX}"` : `type="text" autocomplete="name" maxlength="${NAME_MAX}"`;
  return (
    `<div class="field${errors[key] ? " bad" : ""}"><label class="lbl" for="${key}">${label}${reqMark(true)}</label>` +
    `<input ${attrs} id="${key}" name="${key}" value="${escapeHtml(values[key] ?? "")}" required${aria}>${errMsg(errors, key)}</div>`
  );
}

export interface TicketsPageOptions {
  config: TicketConfig;
  values?: FormValues;
  errors?: FormErrors;
  canceled?: boolean;
  demo?: boolean;
}

export function renderTicketsPage(o: TicketsPageOptions): string {
  const { config } = o;
  const values = o.values ?? {};
  const errors = o.errors ?? {};
  const selectable = config.types.filter((t) => isSelectable(t, config.paymentReady));
  let body = '<h1>チケット購入</h1><p class="lead">券種を選び、必要事項を入力してお申し込みください。</p>';
  if (o.canceled) body += '<div class="alert info" role="status">お支払いはキャンセルされました。</div>';
  if (errors._form) body += `<div class="alert err" role="alert">${escapeHtml(errors._form)}</div>`;

  if (selectable.length === 0) {
    return shell(
      "チケット購入",
      body + '<section class="panel done"><h1>受付準備中</h1><p class="lead">現在お申し込みいただけるチケットはありません。公開までしばらくお待ちください。</p><a class="btn2" href="/">トップへ戻る</a></section>',
      !!o.demo,
    );
  }

  const chosen = selectable.some((t) => t.id === values.ticketType) ? values.ticketType : selectable[0].id;
  const hasPaid = config.types.some((t) => t.priceJpy > 0);
  body +=
    '<form class="panel" method="post" action="/tickets/checkout" novalidate>' +
    `<fieldset class="${errors.ticketType ? "bad" : ""}"><legend>券種${reqMark(true)}</legend><div class="types">` +
    config.types.map((t) => renderType(t, config.paymentReady, t.id === chosen)).join("") +
    `</div>${errMsg(errors, "ticketType")}</fieldset>` +
    fixedField("name", "氏名", values, errors) +
    fixedField("email", "メールアドレス", values, errors) +
    config.fields.map((f) => renderField(f, values, errors)).join("") +
    `<div class="hp" aria-hidden="true"><label>空欄のままにしてください<input type="text" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></label></div>` +
    (hasPaid ? '<p class="note">有料チケットは Stripe の決済画面に移動してお支払いいただきます。無料チケットはそのままお申し込みが完了します。</p>' : "") +
    '<button class="submit" type="submit">購入手続きへ</button></form>';
  return shell("チケット購入", body, !!o.demo);
}

export type ThanksStatus = "paid" | "free" | "pending" | "expired" | "unknown";

export function renderThanksPage(o: { status: ThanksStatus; ticketTypeName?: string; demo?: boolean }): string {
  let inner: string;
  if (o.status === "paid" || o.status === "free") {
    inner =
      "<h1>お申し込みが完了しました</h1>" +
      (o.ticketTypeName ? `<p class="tn">${escapeHtml(o.ticketTypeName)}</p>` : "") +
      '<p class="lead">ご登録のメールアドレスに確認メールをお送りします。当日お会いできるのを楽しみにしています。</p>';
  } else if (o.status === "pending") {
    inner = '<h1>決済を確認中です</h1><p class="lead">決済を確認中です（数分後にメールをご確認ください）。</p>';
  } else if (o.status === "expired") {
    inner = '<h1>お手続きの有効期限が切れました</h1><p class="lead">お手数ですが、もう一度お申し込みください。</p><a class="btn2" href="/tickets">チケット購入へ</a>';
  } else {
    inner = '<h1>お申し込みを受け付けました</h1><p class="lead">お申し込み状況はご登録のメールアドレスをご確認ください。ご不明な点は事務局までお問い合わせください。</p>';
  }
  return shell("お申し込み", `<section class="panel done">${inner}<p><a class="btn2" href="/">トップへ戻る</a></p></section>`, !!o.demo);
}

export function ticketsCta(): string {
  return (
    '<a id="lp-tickets-cta" href="/tickets" style="position:fixed;right:16px;bottom:16px;z-index:2147483646;' +
    "display:inline-flex;align-items:center;gap:8px;padding:12px 22px;border-radius:999px;" +
    "background:linear-gradient(120deg,#2a5fd0 0%,#2b78bd 100%);color:#fff;text-decoration:none;" +
    "font:800 15px/1.2 'Zen Kaku Gothic New',system-ui,-apple-system,sans-serif;" +
    'box-shadow:0 12px 26px -6px rgba(47,97,214,.42);white-space:nowrap">チケットを購入</a>'
  );
}

// ---------- handler ----------

const BASE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
};

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { ...BASE_HEADERS, "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { ...BASE_HEADERS, location } });
}

export interface TicketsDeps {
  demo: boolean;
  /** Ticket config, or null when unavailable (treated as flag off). */
  getConfig(): Promise<TicketConfig | null>;
  /** Drops the cached config (e.g. after a sold_out). */
  invalidate(): void;
  /** Calls lp-analytics (path like "/lp/internal/tickets/checkout"); null when no binding. */
  internal: ((path: string, init: RequestInit) => Promise<Response>) | null;
}

/**
 * Handles /tickets*. Returns null when the request is not a tickets route, or the feature is
 * off / unavailable — the caller then serves the normal version 404.
 */
export async function handleTickets(req: Request, deps: TicketsDeps): Promise<Response | null> {
  const url = new URL(req.url);
  const route = matchTicketsRoute(url.pathname);
  if (!route) return null;

  if (route === "webhook") {
    if (req.method !== "POST") return null;
    if (!deps.internal) return new Response("unavailable", { status: 503, headers: BASE_HEADERS });
    const headers: Record<string, string> = { "content-type": req.headers.get("content-type") ?? "application/json" };
    const sig = req.headers.get("stripe-signature");
    if (sig) headers["stripe-signature"] = sig;
    const up = await deps.internal("/lp/internal/tickets/stripe-webhook", {
      method: "POST",
      headers,
      body: await req.arrayBuffer(),
    });
    return new Response(up.body, {
      status: up.status,
      headers: { ...BASE_HEADERS, "content-type": up.headers.get("content-type") ?? "application/json" },
    });
  }

  const config = await deps.getConfig();
  if (!config || !config.enabled) return null;

  if (route === "page") {
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    return htmlResponse(renderTicketsPage({ config, canceled: url.searchParams.get("canceled") === "1", demo: deps.demo }));
  }

  if (route === "thanks") {
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    const sessionId = url.searchParams.get("session_id");
    const order = url.searchParams.get("order");
    if (deps.demo || !deps.internal || (!sessionId && !order)) {
      return htmlResponse(renderThanksPage({ status: deps.demo && order ? "free" : "unknown", demo: deps.demo }));
    }
    // Never trust the query string: both paid (session_id) and free (order) are confirmed server-side.
    let status: ThanksStatus = "unknown";
    let ticketTypeName: string | undefined;
    try {
      const res = await deps.internal("/lp/internal/tickets/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sessionId ? { sessionId } : { orderId: order }),
      });
      if (res.ok) {
        const b = (await res.json()) as { status?: unknown; ticketTypeName?: unknown };
        if (b.status === "paid" || b.status === "pending" || b.status === "expired") status = b.status;
        if (typeof b.ticketTypeName === "string") ticketTypeName = b.ticketTypeName;
      }
    } catch {
      // fall through to the generic message
    }
    return htmlResponse(renderThanksPage({ status, ticketTypeName: status === "paid" ? ticketTypeName : undefined, demo: deps.demo }));
  }

  // route === "checkout"
  if (req.method !== "POST") return redirect("/tickets");
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return new Response("Forbidden", { status: 403, headers: BASE_HEADERS });
  const text = await req.text();
  if (text.length > BODY_MAX) return new Response("Payload Too Large", { status: 413, headers: BASE_HEADERS });
  const parsed = parseCheckoutForm(new URLSearchParams(text), config);
  if (!parsed.ok) {
    if (parsed.spam) return redirect("/tickets/thanks");
    return htmlResponse(renderTicketsPage({ config, values: parsed.values, errors: parsed.errors, demo: deps.demo }), 400);
  }
  if (deps.demo) return redirect("/tickets/thanks?order=demo");
  if (!deps.internal) {
    return htmlResponse(renderTicketsPage({ config, values: parsed.values, errors: mapCheckoutError(503, null, config) }), 503);
  }

  let res: Response;
  try {
    res = await deps.internal("/lp/internal/tickets/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...parsed.input, origin: url.origin }),
    });
  } catch {
    return htmlResponse(renderTicketsPage({ config, values: parsed.values, errors: mapCheckoutError(502, null, config) }), 502);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok) {
    const target = body && typeof body === "object" ? str((body as { redirectUrl?: unknown }).redirectUrl) : "";
    if (/^https?:\/\//.test(target)) return redirect(target);
    return htmlResponse(renderTicketsPage({ config, values: parsed.values, errors: mapCheckoutError(502, null, config) }), 502);
  }
  let shown = config;
  if (res.status === 409) {
    deps.invalidate();
    shown = (await deps.getConfig()) ?? config;
  }
  const errors = mapCheckoutError(res.status, body, shown);
  return htmlResponse(renderTicketsPage({ config: shown, values: parsed.values, errors }), res.status >= 400 && res.status < 600 ? res.status : 502);
}
