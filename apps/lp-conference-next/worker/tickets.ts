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
// Mirrors the LP's visual language (v3.x: deep-navy hero with brand aurora, Inter + Zen Kaku
// Gothic New, indigo headings, blue/teal gradients, soft blue shadows). Server-rendered and
// fully usable without JS; the tiny inline script only adds the live order summary and
// scroll-reveal. All motion collapses under prefers-reduced-motion.

const FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Zen+Kaku+Gothic+New:wght@400;500;700;900&display=swap";

const STYLE = `
:root{--h:#101ca8;--ink:#24272e;--soft:#4b5563;--mute:#6b7280;--blue:#2f61d6;--deep:#1e3fa8;--btn:#2a5fd0;--teal:#17b892;--gold:#f2c14e;
--link:#1a5fb8;--alt:#f6f9fe;--bd:rgba(16,28,168,.10);--bds:rgba(16,28,168,.06);--err:#b42318;--errbg:#fef3f2;--navy:#0e1330;--sec:#eef4fd;
--sh-md:0 6px 16px -4px rgba(16,42,100,.12),0 2px 6px -2px rgba(16,42,100,.08);
--sh-lg:0 16px 34px -8px rgba(16,42,100,.16),0 6px 14px -6px rgba(16,42,100,.10);
--sh-xl:0 28px 56px -12px rgba(16,42,100,.20),0 12px 24px -10px rgba(16,42,100,.12);
--sh-cta:0 12px 26px -6px rgba(47,97,214,.42);--grad:linear-gradient(120deg,#1f9bd6 0%,#17b892 100%);
--font:"Inter","Zen Kaku Gothic New","Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,-apple-system,sans-serif;
--disp:"Zen Kaku Gothic New","Inter","Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif;--w:1100px}
*,*::before,*::after{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font-family:var(--font);color:var(--ink);background:var(--sec);line-height:1.75;-webkit-font-smoothing:antialiased}
a{color:var(--link)}
:where(a,button,input,select,textarea):focus-visible{outline:3px solid rgba(47,97,214,.5);outline-offset:2px}
.demo{position:relative;z-index:5;background:#fff4d6;color:#7a4b00;text-align:center;font-size:13px;font-weight:700;padding:6px 16px}
.wrap{max-width:var(--w);margin:0 auto;padding:0 24px}

/* header over the hero */
.top{position:absolute;inset:0 0 auto;z-index:3}
.top .wrap{display:flex;justify-content:space-between;align-items:center;gap:16px;padding-top:22px}
.brand{display:inline-flex;align-items:center;gap:10px;color:#fff;text-decoration:none}
.mark{width:32px;height:32px;border-radius:9px;flex:none;background:#0c1533 url("/img/brand-logo.png") center/82% no-repeat;box-shadow:0 6px 16px -6px rgba(47,97,214,.6),inset 0 0 0 1px rgba(255,255,255,.14)}
.bname{display:flex;flex-direction:column;line-height:1.1;font-weight:800;letter-spacing:.06em;font-size:12px}
.bname b{font-size:15px;letter-spacing:.04em;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.back{display:inline-flex;align-items:center;gap:6px;color:#dbe6ff;font-size:14px;font-weight:700;text-decoration:none;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.08);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-radius:999px;padding:8px 16px;transition:background .2s,border-color .2s}
.back:hover{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.4)}
.back span{transition:transform .2s}.back:hover span{transform:translateX(-3px)}

/* hero: same deep-navy + aurora grammar as the LP v3.1 hero */
.hero{position:relative;isolation:isolate;overflow:hidden;color:#eaf1ff;padding:132px 0 150px;
background:radial-gradient(120% 90% at 50% 42%,rgba(24,70,165,.55) 0%,transparent 60%),linear-gradient(160deg,#04081e 0%,#071235 55%,#05244a 100%)}
.hero.sm{padding:120px 0 170px}
.blob{position:absolute;z-index:-1;border-radius:50%;filter:blur(60px);opacity:.55;will-change:transform;animation:drift 22s ease-in-out infinite alternate}
.b1{width:560px;height:560px;left:-160px;top:-200px;background:radial-gradient(circle at 35% 35%,#2f61d6 0%,rgba(47,97,214,0) 68%)}
.b2{width:480px;height:480px;right:-140px;top:-60px;background:radial-gradient(circle at 50% 50%,#17b892 0%,rgba(23,184,146,0) 66%);animation-duration:26s;animation-delay:-8s;opacity:.42}
.b3{width:320px;height:320px;left:46%;bottom:-170px;background:radial-gradient(circle,#f2c14e 0%,rgba(242,193,78,0) 66%);animation-duration:30s;animation-delay:-14s;opacity:.28}
@keyframes drift{0%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(60px,40px,0) scale(1.12)}100%{transform:translate3d(-40px,70px,0) scale(.94)}}
.net{position:absolute;inset:0;z-index:-1;width:100%;height:100%;opacity:.5;-webkit-mask-image:radial-gradient(80% 80% at 50% 40%,#000 30%,transparent 80%);mask-image:radial-gradient(80% 80% at 50% 40%,#000 30%,transparent 80%)}
.net line{stroke:rgba(150,190,255,.22);stroke-width:1}
.net circle{fill:#9ec3ff;animation:twinkle 4s ease-in-out infinite}
.net circle:nth-child(3n){animation-delay:-1.3s;fill:#5fe0c0}.net circle:nth-child(4n){animation-delay:-2.6s}
@keyframes twinkle{0%,100%{opacity:.25}50%{opacity:1}}
.ghost{position:absolute;z-index:-1;right:-2vw;bottom:-.18em;font:900 clamp(96px,17vw,240px)/1 "Inter",sans-serif;letter-spacing:-.04em;color:transparent;-webkit-text-stroke:1px rgba(255,255,255,.09);white-space:nowrap;pointer-events:none;user-select:none}
.eyebrow{display:inline-flex;align-items:center;gap:10px;font:800 12px/1 "Inter",sans-serif;letter-spacing:.18em;color:#c6dbff;padding:9px 14px;border-radius:999px;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.22);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.eyebrow::before{content:"";width:8px;height:8px;border-radius:50%;background:linear-gradient(135deg,var(--blue),var(--teal));box-shadow:0 0 0 3px rgba(120,170,255,.28)}
.hero h1{font-family:var(--disp);font-weight:900;font-size:clamp(40px,7.4vw,84px);line-height:1.08;letter-spacing:.01em;margin:22px 0 18px;color:#fff}
.hero h1 .g{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero .sub{font-size:clamp(15px,1.8vw,18px);color:#c9d6f2;margin:0;max-width:640px}
.meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:28px}
.chip{display:inline-flex;align-items:center;gap:10px;padding:10px 16px;border-radius:14px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.16);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);font-weight:700;font-size:15px;color:#fff}
.chip i{font-style:normal;font-size:11px;font-weight:800;letter-spacing:.12em;color:#8fb4ff}
.rise{animation:rise .9s cubic-bezier(.2,.7,.2,1) both}
.d1{animation-delay:.08s}.d2{animation-delay:.18s}.d3{animation-delay:.28s}.d4{animation-delay:.38s}
@keyframes rise{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:none}}

/* steps */
.steps{display:flex;gap:8px;margin:34px 0 0;padding:0;list-style:none;flex-wrap:wrap}
.steps li{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:#b9c8ea}
.steps li b{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;font:800 12px/1 "Inter",sans-serif;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.25);color:#fff}
.steps li.on b{background:var(--grad);border-color:transparent}
.steps li+li::before{content:"";width:22px;height:1px;background:rgba(255,255,255,.3);margin-right:2px}

/* body */
.body{position:relative;z-index:2;margin-top:-92px;padding-bottom:96px}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:28px;align-items:start}
.card{background:#fff;border:1px solid var(--bds);border-radius:24px;box-shadow:var(--sh-xl);padding:36px}
.card+.card{margin-top:24px}
.shead{display:flex;align-items:baseline;gap:14px;margin:0 0 22px}
.shead .no{font:900 13px/1 "Inter",sans-serif;letter-spacing:.14em;color:var(--blue)}
.shead h2{margin:0;font-family:var(--disp);font-size:24px;font-weight:900;color:var(--h);letter-spacing:.02em}
.shead p{margin:0 0 0 auto;font-size:13px;color:var(--mute)}
.alert{display:flex;gap:10px;align-items:flex-start;border-radius:16px;padding:14px 18px;margin:0 0 20px;font-weight:700;font-size:15px;box-shadow:var(--sh-md)}
.alert.err{background:var(--errbg);color:var(--err);border:1px solid #fecdca}
.alert.info{background:#fff;color:var(--h);border:1px solid var(--bd)}
fieldset{border:0;margin:0;padding:0;min-width:0}
legend{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.req{display:inline-block;color:#fff;background:var(--err);font-size:11px;font-weight:800;border-radius:6px;padding:1px 7px;margin-left:8px;vertical-align:2px}
.opt{display:inline-block;color:var(--mute);background:#eef0f4;font-size:11px;font-weight:700;border-radius:6px;padding:1px 7px;margin-left:8px;vertical-align:2px}

/* ticket cards (ticket-stub shape) */
.types{display:grid;gap:16px}
.tk{--nb:var(--bd);position:relative;display:grid;grid-template-columns:minmax(0,1fr) 150px;border-radius:18px;background:#fff;border:1.5px solid var(--nb);cursor:pointer;
transition:transform .25s cubic-bezier(.2,.7,.2,1),box-shadow .25s,border-color .2s;box-shadow:var(--sh-md)}
.tk:hover{transform:translateY(-3px);box-shadow:var(--sh-lg);--nb:rgba(47,97,214,.45)}
.tk:has(input:checked){--nb:var(--blue);box-shadow:0 0 0 4px rgba(47,97,214,.14),var(--sh-lg);background:linear-gradient(180deg,#fff 0%,#f4f8ff 100%)}
.tk:has(input:focus-visible){outline:3px solid rgba(47,97,214,.5);outline-offset:3px}
.tk input{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px}
.tk-main{padding:22px 24px 22px 26px;min-width:0;position:relative}
.tk-main::before{content:"";position:absolute;left:0;top:18px;bottom:18px;width:4px;border-radius:0 4px 4px 0;background:var(--grad);opacity:0;transition:opacity .2s}
.tk:has(input:checked) .tk-main::before{opacity:1}
.tk-name{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-family:var(--disp);font-weight:900;font-size:20px;color:var(--h);letter-spacing:.02em}
.tk-desc{display:block;color:var(--soft);font-size:14px;margin-top:6px}
.tk-stub{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:18px 12px;border-left:2px dashed rgba(16,28,168,.14)}
.tk-stub::before,.tk-stub::after{content:"";position:absolute;left:-12px;width:22px;height:22px;border-radius:50%;background:#fff;border:1.5px solid var(--nb);transition:border-color .2s}
.tk-stub::before{top:-12px;clip-path:inset(50% 0 0 0)}
.tk-stub::after{bottom:-12px;clip-path:inset(0 0 50% 0)}
.tk-price{font:900 26px/1 "Inter",var(--disp);letter-spacing:-.01em;color:var(--h)}
.tk-price.free{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;font-family:var(--disp);font-size:22px}
.tk-check{width:26px;height:26px;border-radius:50%;border:2px solid #cfd6e4;display:grid;place-items:center;transition:all .2s}
.tk-check::after{content:"";width:10px;height:6px;border:2.5px solid #fff;border-top:0;border-right:0;transform:rotate(-45deg) translate(1px,-1px) scale(.4);opacity:0;transition:all .2s}
.tk:has(input:checked) .tk-check{background:var(--grad);border-color:transparent;box-shadow:0 6px 14px -4px rgba(23,184,146,.6)}
.tk:has(input:checked) .tk-check::after{opacity:1;transform:rotate(-45deg) translate(1px,-1px) scale(1)}
.tk.off{cursor:not-allowed;box-shadow:none;background:#f8f9fb}
.tk.off:hover{transform:none;--nb:var(--bd)}
.tk.off .tk-name,.tk.off .tk-price{color:#8a93a6}.tk.off .tk-price.free{-webkit-text-fill-color:#8a93a6}
.tk.off .tk-check{opacity:.35}
.badge{display:inline-block;font:800 11px/1 var(--font);border-radius:999px;padding:5px 10px;background:#eceef2;color:var(--soft);letter-spacing:.04em}
.badge.so{background:#fde8e7;color:var(--err)}
.bad .types .tk{--nb:rgba(180,35,24,.35)}

/* form fields */
.field{margin:0 0 22px}
.field:last-child{margin-bottom:0}
.lbl{display:block;font-weight:800;color:var(--ink);margin:0 0 8px;font-size:15px}
input[type=text],input[type=email],select,textarea{width:100%;font:inherit;font-size:16px;color:var(--ink);background:#fbfcff;border:1.5px solid #d5dbe8;border-radius:12px;padding:13px 16px;transition:border-color .15s,box-shadow .15s,background .15s}
input[type=text]:hover,input[type=email]:hover,select:hover,textarea:hover{border-color:#b5c2dc}
textarea{min-height:120px;resize:vertical}
select{appearance:none;-webkit-appearance:none;padding-right:44px;background-image:linear-gradient(45deg,transparent 50%,#4b5563 50%),linear-gradient(135deg,#4b5563 50%,transparent 50%);background-position:calc(100% - 22px) 52%,calc(100% - 16px) 52%;background-size:6px 6px;background-repeat:no-repeat}
input:focus,select:focus,textarea:focus{border-color:var(--blue);background-color:#fff;outline:none;box-shadow:0 0 0 4px rgba(47,97,214,.14)}
.bad input[type=text],.bad input[type=email],.bad select,.bad textarea{border-color:var(--err);background-color:#fffafa}
.msg{display:flex;align-items:center;gap:6px;color:var(--err);font-size:13px;font-weight:700;margin:8px 0 0}
.msg::before{content:"!";display:grid;place-items:center;width:16px;height:16px;border-radius:50%;background:var(--err);color:#fff;font-size:11px;font-weight:900;flex:none}
.check{display:flex;gap:12px;align-items:center;font-weight:600;cursor:pointer;padding:14px 16px;border:1.5px solid #d5dbe8;border-radius:12px;background:#fbfcff}
.check:has(input:checked){border-color:var(--blue);background:#f4f8ff}
.check input{width:20px;height:20px;accent-color:var(--btn);flex:none}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
.two{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}
.two .field:last-child{margin-bottom:22px}

/* order summary (sticky, ticket-like) */
.sum{position:sticky;top:24px}
.sum-card{position:relative;overflow:hidden;isolation:isolate;border-radius:24px;padding:28px;color:#eaf1ff;box-shadow:var(--sh-xl);
background:radial-gradient(120% 80% at 100% 0%,rgba(23,184,146,.32) 0%,transparent 55%),radial-gradient(120% 90% at 0% 100%,rgba(47,97,214,.55) 0%,transparent 60%),linear-gradient(160deg,#071235 0%,#0b1d55 100%)}
.sum-card::after{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(115deg,transparent 30%,rgba(255,255,255,.09) 45%,transparent 60%);transform:translateX(-100%);animation:sheen 6s ease-in-out infinite}
@keyframes sheen{0%,55%{transform:translateX(-100%)}80%,100%{transform:translateX(100%)}}
.sum-k{font:800 11px/1 "Inter",sans-serif;letter-spacing:.18em;color:#8fb4ff;margin:0 0 14px}
.sum-name{font-family:var(--disp);font-weight:900;font-size:22px;color:#fff;margin:0;line-height:1.35}
.sum-ev{font-size:13px;color:#b9c8ea;margin:6px 0 0}
.sum-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin:22px 0 0;padding:18px 0 0;border-top:1.5px dashed rgba(255,255,255,.2)}
.sum-row span{font-size:13px;font-weight:700;color:#b9c8ea}
.sum-price{font:900 34px/1 "Inter",var(--disp);color:#fff;letter-spacing:-.01em}
.submit{position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;gap:10px;width:100%;margin-top:22px;border:0;border-radius:999px;padding:17px 24px;font:inherit;font-size:17px;font-weight:900;letter-spacing:.04em;color:#fff;cursor:pointer;
background:linear-gradient(120deg,#2a5fd0 0%,#1f9bd6 55%,#17b892 100%);background-size:160% 100%;box-shadow:0 14px 30px -8px rgba(23,184,146,.55);transition:background-position .4s,transform .2s,box-shadow .2s}
.submit:hover{background-position:100% 0;transform:translateY(-2px);box-shadow:0 18px 36px -8px rgba(23,184,146,.65)}
.submit .ar{transition:transform .2s}.submit:hover .ar{transform:translateX(4px)}
.submit.is-busy{pointer-events:none;opacity:.85}
.submit.is-busy .ar{display:none}
.submit.is-busy::after{content:"";width:18px;height:18px;border-radius:50%;border:2.5px solid rgba(255,255,255,.4);border-top-color:#fff;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.secure{display:flex;align-items:center;justify-content:center;gap:6px;font-size:12px;color:#b9c8ea;margin:14px 0 0;text-align:center}
.note{font-size:13px;color:var(--mute);margin:16px 4px 0;line-height:1.7}

/* thanks / unavailable */
.done{max-width:640px;margin:0 auto;text-align:center;padding:48px 40px}
.done h2{font-family:var(--disp);font-size:clamp(22px,3.2vw,28px);font-weight:900;color:var(--h);margin:20px 0 10px;line-height:1.4}
.done .lead{color:var(--soft);margin:0 auto;max-width:460px}
.ico{width:84px;height:84px;margin:0 auto;border-radius:50%;display:grid;place-items:center;background:var(--grad);box-shadow:0 18px 40px -10px rgba(23,184,146,.6)}
.ico.wait{background:linear-gradient(135deg,#2f61d6,#1f9bd6);box-shadow:0 18px 40px -10px rgba(47,97,214,.55)}
.ico.warn{background:linear-gradient(135deg,#f2a93b,#f2c14e);box-shadow:0 18px 40px -10px rgba(242,169,59,.55)}
.ico svg{width:40px;height:40px;fill:none;stroke:#fff;stroke-width:3.2;stroke-linecap:round;stroke-linejoin:round}
.ico .ck{stroke-dasharray:40;stroke-dashoffset:40;animation:draw .7s .35s cubic-bezier(.65,0,.35,1) forwards}
.ico.pop{animation:pop .6s cubic-bezier(.2,1.4,.4,1) both}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes pop{from{transform:scale(.4);opacity:0}to{transform:none;opacity:1}}
.ico.wait svg{animation:spin 2.4s linear infinite}
.pass{display:grid;grid-template-columns:1fr auto;align-items:center;gap:16px;margin:26px auto 0;max-width:420px;text-align:left;border-radius:18px;padding:18px 22px;color:#fff;
background:radial-gradient(120% 90% at 100% 0%,rgba(23,184,146,.35) 0%,transparent 55%),linear-gradient(160deg,#071235 0%,#0b1d55 100%);box-shadow:var(--sh-lg)}
.pass small{display:block;font:800 10px/1 "Inter",sans-serif;letter-spacing:.18em;color:#8fb4ff;margin-bottom:6px}
.pass b{font-family:var(--disp);font-size:20px;font-weight:900}
.pass i{font-style:normal;font:800 11px/1 "Inter",sans-serif;letter-spacing:.12em;color:#5fe0c0;border:1px solid rgba(95,224,192,.5);border-radius:999px;padding:6px 10px}
.acts{display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-top:30px}
.btn1,.btn2{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:13px 26px;font-weight:800;text-decoration:none;transition:transform .2s,box-shadow .2s}
.btn1{color:#fff;background:linear-gradient(120deg,#2a5fd0 0%,#2b78bd 100%);box-shadow:var(--sh-cta)}
.btn2{color:var(--btn);border:1.5px solid rgba(42,95,208,.4);background:#fff}
.btn1:hover,.btn2:hover{transform:translateY(-2px)}

footer{background:var(--navy);color:rgba(255,255,255,.6);font-size:13px}
footer .wrap{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;padding-top:36px;padding-bottom:36px}
footer .brand{color:#fff}
footer a.fl{color:rgba(255,255,255,.75);text-decoration:none;font-weight:600}
footer a.fl:hover{color:#fff;text-decoration:underline}

/* scroll reveal (JS only adds .js; content is visible without it) */
.js .rv{opacity:0;transform:translateY(26px);transition:opacity .8s cubic-bezier(.2,.7,.2,1),transform .8s cubic-bezier(.2,.7,.2,1)}
.js .rv.in{opacity:1;transform:none}

@media (max-width:920px){.grid{grid-template-columns:1fr}.sum{position:static}}
@media (max-width:600px){
.wrap{padding:0 16px}.hero{padding:110px 0 128px}.hero.sm{padding:104px 0 150px}
.card{padding:22px 18px;border-radius:20px}.done{padding:36px 20px}
.tk{grid-template-columns:minmax(0,1fr) 104px}.tk-main{padding:18px 14px 18px 18px}.tk-name{font-size:17px}.tk-price{font-size:20px}.tk-price.free{font-size:18px}
.two{grid-template-columns:1fr}.ey2{display:none}.shead p{display:none}.bname{display:none}.steps li span{display:none}.steps li+li::before{width:14px}
}
@media (prefers-reduced-motion:reduce){
*,*::before,*::after{animation:none!important;transition:none!important}
html{scroll-behavior:auto}.ico .ck{stroke-dashoffset:0}.js .rv{opacity:1;transform:none}
}
`;

// Small, dependency-free progressive enhancement: live summary + submit spinner + reveal.
const SCRIPT = `(function(){var d=document;d.documentElement.classList.add("js");
var rv=[].slice.call(d.querySelectorAll(".rv"));if("IntersectionObserver"in window){var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add("in");io.unobserve(e.target)}})},{rootMargin:"0px 0px -8% 0px"});rv.forEach(function(el){io.observe(el)})}else rv.forEach(function(el){el.classList.add("in")});
var f=d.querySelector("form.buy");if(!f)return;var n=f.querySelector("[data-sum-name]"),p=f.querySelector("[data-sum-price]");
function up(){var r=f.querySelector("input[name=ticketType]:checked");if(!r)return;var c=r.closest(".tk");if(n)n.textContent=c.getAttribute("data-name");if(p)p.textContent=c.getAttribute("data-price")}
f.addEventListener("change",up);up();f.addEventListener("submit",function(){var b=f.querySelector(".submit");if(b){b.classList.add("is-busy");b.setAttribute("aria-busy","true")}})})();`;

const CONF_NAME = "北陸ITカンファレンス 2027";
const EVENT_DATE = "2027年9月13日(月)・14日(火)";
const EVENT_VENUE = "金沢工業大学";

// Decorative constellation, same motif as the LP hero network.
const NET = (() => {
  const pts: Array<[number, number]> = [
    [60, 80], [180, 40], [300, 120], [420, 60], [560, 140], [700, 70], [840, 130], [960, 50], [1100, 110],
    [120, 220], [260, 260], [400, 210], [540, 290], [680, 230], [820, 300], [980, 240], [1120, 280],
  ];
  const lines: string[] = [];
  const links = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [0, 9], [9, 10], [10, 11], [11, 12], [12, 13], [13, 14], [14, 15], [15, 16], [2, 11], [4, 12], [6, 14], [8, 16], [3, 11], [5, 13]];
  for (const [a, b] of links) lines.push(`<line x1="${pts[a][0]}" y1="${pts[a][1]}" x2="${pts[b][0]}" y2="${pts[b][1]}"/>`);
  const dots = pts.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i % 3 === 0 ? 3 : 2}"/>`);
  return `<svg class="net" viewBox="0 0 1180 340" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${lines.join("")}<g>${dots.join("")}</g></svg>`;
})();

const BRAND =
  '<span class="mark" aria-hidden="true"></span><span class="bname">HOKURIKU IT CONFERENCE<b>2027</b></span>';

function hero(o: { title: string; sub?: string; ghost: string; step?: number; small?: boolean }): string {
  const steps =
    o.step === undefined
      ? ""
      : '<ol class="steps rise d4" aria-label="お申し込みの流れ">' +
        ["券種を選ぶ", "参加者情報", "お支払い・完了"]
          .map((s, i) => `<li${i + 1 <= o.step! ? ' class="on"' : ""}><b>${i + 1}</b><span>${s}</span></li>`)
          .join("") +
        "</ol>";
  return (
    `<section class="hero${o.small ? " sm" : ""}">` +
    '<span class="blob b1" aria-hidden="true"></span><span class="blob b2" aria-hidden="true"></span><span class="blob b3" aria-hidden="true"></span>' +
    NET +
    `<span class="ghost" aria-hidden="true">${o.ghost}</span>` +
    '<div class="wrap">' +
    '<span class="eyebrow rise">TICKETS<span class="ey2"> · HOKURIKU IT CONFERENCE 2027</span></span>' +
    `<h1 class="rise d1">${o.title}</h1>` +
    (o.sub ? `<p class="sub rise d2">${o.sub}</p>` : "") +
    '<div class="meta rise d3">' +
    `<span class="chip"><i>DATE</i>${EVENT_DATE}</span><span class="chip"><i>VENUE</i>${EVENT_VENUE}</span>` +
    "</div>" +
    steps +
    "</div></section>"
  );
}

function shell(title: string, body: string, demo: boolean): string {
  return (
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<meta name="theme-color" content="#071235">' +
    `<title>${escapeHtml(title)}｜${CONF_NAME}</title>` +
    '<link rel="icon" href="/favicon.ico">' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    `<link rel="stylesheet" href="${FONT_HREF}">` +
    `<style>${STYLE}</style></head><body>` +
    (demo ? '<div class="demo" role="note">デモ環境です（実際の決済は行われません）</div>' : "") +
    '<div style="position:relative">' +
    `<header class="top"><div class="wrap"><a class="brand" href="/" aria-label="${CONF_NAME} トップへ">${BRAND}</a>` +
    '<a class="back" href="/"><span aria-hidden="true">←</span>トップへ戻る</a></div></header>' +
    `<main>${body}</main></div>` +
    `<footer><div class="wrap"><a class="brand" href="/" aria-label="トップへ">${BRAND}</a>` +
    `<a class="fl" href="/">公式サイトへ</a><span>&copy; ${CONF_NAME}</span></div></footer>` +
    `<script>${SCRIPT}</script></body></html>`
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
  const badge = t.soldOut ? '<span class="badge so">売り切れ</span>' : !selectable ? '<span class="badge">決済準備中</span>' : "";
  const price = formatPrice(t.priceJpy);
  return (
    `<label class="tk${selectable ? "" : " off"}" data-name="${escapeHtml(t.name)}" data-price="${escapeHtml(price)}">` +
    `<input type="radio" name="ticketType" value="${escapeHtml(t.id)}"${checked && selectable ? " checked" : ""}${selectable ? "" : " disabled"} required>` +
    `<span class="tk-main"><span class="tk-name">${escapeHtml(t.name)}${badge}</span>` +
    (t.description ? `<span class="tk-desc">${escapeHtml(t.description)}</span>` : "") +
    "</span>" +
    `<span class="tk-stub"><span class="tk-price${t.priceJpy <= 0 ? " free" : ""}">${escapeHtml(price)}</span><span class="tk-check" aria-hidden="true"></span></span>` +
    "</label>"
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
      `${v ? " checked" : ""}${req}${aria}><span>${escapeHtml(f.label)}${reqMark(f.required)}</span></label>${errMsg(errors, key)}</div>`
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
  const attrs =
    key === "email"
      ? `type="email" autocomplete="email" maxlength="${EMAIL_MAX}" placeholder="you@example.com"`
      : `type="text" autocomplete="name" maxlength="${NAME_MAX}" placeholder="北陸 太郎"`;
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

const LOCK =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

export function renderTicketsPage(o: TicketsPageOptions): string {
  const { config } = o;
  const values = o.values ?? {};
  const errors = o.errors ?? {};
  const selectable = config.types.filter((t) => isSelectable(t, config.paymentReady));
  const top = hero({
    title: 'チケット<span class="g">購入</span>',
    sub: "券種を選び、必要事項を入力してお申し込みください。",
    ghost: "TICKETS",
    step: selectable.length === 0 ? undefined : 1,
  });
  let alerts = "";
  if (o.canceled) alerts += '<div class="alert info" role="status">お支払いはキャンセルされました。</div>';
  if (errors._form) alerts += `<div class="alert err" role="alert">${escapeHtml(errors._form)}</div>`;

  if (selectable.length === 0) {
    return shell(
      "チケット購入",
      top +
        `<div class="body"><div class="wrap">${alerts}<section class="card done rv">` +
        '<div class="ico wait"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-dasharray="4 4"/></svg></div>' +
        '<h2>受付準備中</h2><p class="lead">現在お申し込みいただけるチケットはありません。公開までしばらくお待ちください。</p>' +
        '<div class="acts"><a class="btn1" href="/">トップへ戻る</a></div></section></div></div>',
      !!o.demo,
    );
  }

  const chosen = selectable.some((t) => t.id === values.ticketType) ? values.ticketType : selectable[0].id;
  const chosenType = selectable.find((t) => t.id === chosen)!;
  const hasPaid = config.types.some((t) => t.priceJpy > 0);
  const extra = config.fields.map((f) => renderField(f, values, errors)).join("");
  const form =
    '<form class="buy grid" method="post" action="/tickets/checkout" novalidate><div>' +
    alerts +
    `<section class="card rv"><fieldset class="${errors.ticketType ? "bad" : ""}"><legend>券種（必須）</legend>` +
    '<div class="shead"><span class="no">01</span><h2>券種を選ぶ</h2><p>1 回のお申し込みで 1 枚</p></div>' +
    '<div class="types">' +
    config.types.map((t) => renderType(t, config.paymentReady, t.id === chosen)).join("") +
    `</div>${errMsg(errors, "ticketType")}</fieldset></section>` +
    '<section class="card rv"><div class="shead"><span class="no">02</span><h2>参加者情報</h2><p>確認メールをお送りします</p></div>' +
    `<div class="two">${fixedField("name", "氏名", values, errors)}${fixedField("email", "メールアドレス", values, errors)}</div>` +
    extra +
    `<div class="hp" aria-hidden="true"><label>空欄のままにしてください<input type="text" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></label></div>` +
    "</section></div>" +
    '<aside class="sum rv" aria-label="お申し込み内容"><div class="sum-card">' +
    '<p class="sum-k">YOUR TICKET</p>' +
    `<p class="sum-name" data-sum-name>${escapeHtml(chosenType.name)}</p>` +
    `<p class="sum-ev">${CONF_NAME}<br>${EVENT_DATE}</p>` +
    `<div class="sum-row"><span>お支払い金額</span><b class="sum-price" data-sum-price>${escapeHtml(formatPrice(chosenType.priceJpy))}</b></div>` +
    '<button class="submit" type="submit">購入手続きへ<span class="ar" aria-hidden="true">→</span></button>' +
    (hasPaid ? `<p class="secure">${LOCK}カード決済は Stripe で安全に処理されます</p>` : "") +
    "</div>" +
    (hasPaid
      ? '<p class="note">有料チケットは Stripe の決済画面に移動してお支払いいただきます。無料チケットはそのままお申し込みが完了します。</p>'
      : "") +
    "</aside></form>";
  return shell("チケット購入", top + `<div class="body"><div class="wrap">${form}</div></div>`, !!o.demo);
}

export type ThanksStatus = "paid" | "free" | "pending" | "expired" | "unknown";

const ICON_OK = '<div class="ico pop"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="ck" d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>';
const ICON_WAIT = '<div class="ico wait pop"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/></svg></div>';
const ICON_WARN = '<div class="ico warn pop"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v6M12 17h.01"/></svg></div>';

export function renderThanksPage(o: { status: ThanksStatus; ticketTypeName?: string; demo?: boolean }): string {
  let inner: string;
  let acts = '<a class="btn1" href="/">トップへ戻る</a>';
  let step = 3;
  if (o.status === "paid" || o.status === "free") {
    inner =
      ICON_OK +
      "<h2>お申し込みが完了しました</h2>" +
      '<p class="lead">ご登録のメールアドレスに確認メールをお送りします。当日お会いできるのを楽しみにしています。</p>' +
      (o.ticketTypeName
        ? `<div class="pass"><div><small>YOUR TICKET</small><b>${escapeHtml(o.ticketTypeName)}</b></div><i>CONFIRMED</i></div>`
        : "");
  } else if (o.status === "pending") {
    inner = ICON_WAIT + '<h2>決済を確認中です</h2><p class="lead">決済を確認中です（数分後にメールをご確認ください）。</p>';
  } else if (o.status === "expired") {
    step = 2;
    inner = ICON_WARN + '<h2>お手続きの有効期限が切れました</h2><p class="lead">お手数ですが、もう一度お申し込みください。</p>';
    acts = '<a class="btn1" href="/tickets">チケット購入へ</a><a class="btn2" href="/">トップへ戻る</a>';
  } else {
    inner =
      ICON_OK +
      '<h2>お申し込みを受け付けました</h2><p class="lead">お申し込み状況はご登録のメールアドレスをご確認ください。ご不明な点は事務局までお問い合わせください。</p>';
  }
  const ok = o.status === "paid" || o.status === "free";
  return shell(
    "お申し込み",
    hero({ title: ok ? 'Thank <span class="g">you!</span>' : "お申し込み", ghost: ok ? "THANKS" : "TICKETS", step, small: true }) +
      `<div class="body"><div class="wrap"><section class="card done rv">${inner}<div class="acts">${acts}</div></section></div></div>`,
    !!o.demo,
  );
}

export function ticketsCta(): string {
  return (
    '<a id="lp-tickets-cta" href="/tickets" style="position:fixed;right:16px;bottom:16px;z-index:2147483646;' +
    "display:inline-flex;align-items:center;gap:10px;padding:14px 24px;border-radius:999px;" +
    "background:linear-gradient(120deg,#2a5fd0 0%,#1f9bd6 55%,#17b892 100%);color:#fff;text-decoration:none;" +
    "font:900 15px/1.2 'Zen Kaku Gothic New',system-ui,-apple-system,sans-serif;letter-spacing:.04em;" +
    'box-shadow:0 14px 30px -8px rgba(23,184,146,.55),inset 0 0 0 1px rgba(255,255,255,.18);white-space:nowrap">' +
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z"/><path d="M14 6v12" stroke-dasharray="2 2"/></svg>' +
    "チケットを購入</a>"
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
