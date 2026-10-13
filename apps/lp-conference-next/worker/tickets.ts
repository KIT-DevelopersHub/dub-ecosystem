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
  /** "" = not tied to a day (通し/共通). e.g. "Day 1 - 9/13(月)". */
  dayLabel: string;
  /** Max tickets of this type per order (1..20). */
  maxPerOrder: number;
  /** Seats left after holds; null = no capacity. */
  remaining: number | null;
  soldOut: boolean;
}
export interface TicketConfig {
  enabled: boolean;
  /** Sales are off but this request carries a valid preview link: show the page, never sell. */
  preview: boolean;
  /** Swap the LP's 参加登録 buttons for 参加チケットを購入 (effective only with enabled). */
  ctaEnabled: boolean;
  paymentReady: boolean;
  fields: TicketField[];
  types: PublicTicketType[];
}

export interface CheckoutItem {
  ticketTypeId: string;
  quantity: number;
}
export interface CheckoutInput {
  items: CheckoutItem[];
  name: string;
  email: string;
  answers: Record<string, string>;
}

/** Form values keyed by input name (qty_<typeId> / name / email / f_<fieldId>). */
export type FormValues = Record<string, string>;
/** Inline errors keyed by input name; "items" = cart-level, "_form" = message above the form. */
export type FormErrors = Record<string, string>;

export const HONEYPOT = "website";
export const CHECKBOX_YES = "はい";
const NAME_MAX = 100;
const EMAIL_MAX = 254;
const TEXT_MAX = 200;
const TEXTAREA_MAX = 2000;
const BODY_MAX = 32 * 1024;
/** Total tickets per order (all types). Mirrors lp-analytics. */
export const ORDER_MAX = 20;
const DEFAULT_MAX_PER_ORDER = 10;
const LOW_STOCK = 10;

const DAY1 = "Day 1 - 9/13(月)";
const DAY2 = "Day 2 - 9/14(火)";
export const DEMO_CONFIG: TicketConfig = {
  enabled: true,
  preview: false,
  ctaEnabled: true,
  paymentReady: true,
  fields: [
    { id: "affiliation", label: "所属", type: "text", required: false, options: [] },
    { id: "attendance", label: "参加区分", type: "select", required: true, options: ["現地", "オンライン"] },
  ],
  types: [
    { id: "demo-general-d1", name: "一般", description: "Day 1 の全セッションに参加できます", priceJpy: 3000, dayLabel: DAY1, maxPerOrder: 10, remaining: null, soldOut: false },
    { id: "demo-student-d1", name: "学生", description: "学生の方向け（当日学生証をご提示ください）", priceJpy: 1000, dayLabel: DAY1, maxPerOrder: 10, remaining: 3, soldOut: false },
    { id: "demo-general-d2", name: "一般", description: "Day 2 の全セッションに参加できます", priceJpy: 3000, dayLabel: DAY2, maxPerOrder: 10, remaining: null, soldOut: false },
    { id: "demo-student-d2", name: "学生", description: "学生の方向け（当日学生証をご提示ください）", priceJpy: 1000, dayLabel: DAY2, maxPerOrder: 10, remaining: 0, soldOut: true },
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

export function qtyInputName(typeId: string): string {
  return `qty_${typeId}`;
}

export function isSelectable(t: PublicTicketType, paymentReady: boolean): boolean {
  return !t.soldOut && t.remaining !== 0 && (t.priceJpy <= 0 || paymentReady);
}

/** Largest quantity selectable for a type in one order (0 = not purchasable). */
export function maxQuantity(t: PublicTicketType, paymentReady: boolean): number {
  if (!isSelectable(t, paymentReady)) return 0;
  const cap = t.remaining === null ? t.maxPerOrder : Math.min(t.maxPerOrder, t.remaining);
  return Math.max(0, Math.min(cap, ORDER_MAX));
}

/** Splits "Day 1 - 9/13(月)" into { main: "Day 1", sub: "9/13(月)" }. */
export function splitDayLabel(label: string): { main: string; sub: string } {
  const m = /^(.+?)\s+[-–—·・|｜]\s+(.+)$/.exec(label.trim());
  return m ? { main: m[1], sub: m[2] } : { main: label.trim(), sub: "" };
}

export interface DayGroup {
  dayLabel: string;
  types: PublicTicketType[];
}

/** Groups types by dayLabel, keeping first-appearance order of both groups and types. */
export function groupByDay(types: PublicTicketType[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const t of types) {
    const key = t.dayLabel.trim();
    let g = groups.find((x) => x.dayLabel === key);
    if (!g) {
      g = { dayLabel: key, types: [] };
      groups.push(g);
    }
    g.types.push(t);
  }
  return groups;
}

/** "一般 Day 1 x2、学生 Day 2 x1" — same wording as lp-analytics' confirm summary. */
export function itemsSummary(items: CheckoutItem[], types: PublicTicketType[]): string {
  return items
    .map((i) => {
      const t = types.find((x) => x.id === i.ticketTypeId);
      if (!t) return "";
      const day = t.dayLabel ? ` ${splitDayLabel(t.dayLabel).main}` : "";
      return `${t.name}${day} x${i.quantity}`;
    })
    .filter(Boolean)
    .join("、");
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
    const mpo = r.maxPerOrder;
    const maxPerOrder =
      typeof mpo === "number" && Number.isInteger(mpo) && mpo >= 1 ? Math.min(mpo, ORDER_MAX) : DEFAULT_MAX_PER_ORDER;
    const remaining =
      typeof r.remaining === "number" && Number.isFinite(r.remaining) ? Math.max(0, Math.trunc(r.remaining)) : null;
    types.push({
      id: r.id,
      name: r.name,
      description: str(r.description),
      priceJpy: r.priceJpy,
      dayLabel: str(r.dayLabel).trim(),
      maxPerOrder,
      remaining,
      soldOut: r.soldOut === true || remaining === 0,
    });
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
  return { enabled: o.enabled, preview: o.preview === true, ctaEnabled: o.ctaEnabled === true, paymentReady: o.paymentReady === true, fields, types };
}

// ---------- form parsing / validation ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ParseResult =
  | { ok: true; input: CheckoutInput; values: FormValues }
  | { ok: false; spam: boolean; values: FormValues; errors: FormErrors };

export function parseCheckoutForm(form: URLSearchParams, config: TicketConfig): ParseResult {
  const values: FormValues = {
    name: (form.get("name") ?? "").trim(),
    email: (form.get("email") ?? "").trim(),
  };
  for (const t of config.types) {
    const key = qtyInputName(t.id);
    values[key] = (form.get(key) ?? "").trim();
  }
  for (const f of config.fields) {
    const key = fieldInputName(f.id);
    values[key] = (form.get(key) ?? "").trim();
  }
  if ((form.get(HONEYPOT) ?? "") !== "") return { ok: false, spam: true, values, errors: {} };

  const errors: FormErrors = {};
  const items: CheckoutItem[] = [];
  let total = 0;
  for (const t of config.types) {
    const key = qtyInputName(t.id);
    const raw = values[key];
    if (raw === "" || raw === "0") continue;
    if (!/^\d{1,3}$/.test(raw)) {
      errors[key] = "枚数を選び直してください";
      continue;
    }
    const q = Number(raw);
    if (q === 0) continue;
    const max = maxQuantity(t, config.paymentReady);
    if (t.soldOut || t.remaining === 0) errors[key] = "この券種は売り切れました";
    else if (max === 0) errors[key] = "この券種は現在お申し込みいただけません";
    else if (q > max) {
      errors[key] =
        t.remaining !== null && t.remaining < Math.min(t.maxPerOrder, ORDER_MAX)
          ? `残り${t.remaining}枚です。${t.remaining}枚以下でお選びください`
          : `この券種は1回のお申し込みで${max}枚までです`;
    }
    items.push({ ticketTypeId: t.id, quantity: q });
    total += q;
  }
  if (items.length === 0 && !Object.keys(errors).some((k) => k.startsWith("qty_"))) {
    errors.items = "チケットを 1 枚以上選んでください";
  } else if (total > ORDER_MAX) {
    errors.items = `1 回のお申し込みは合計${ORDER_MAX}枚までです（現在 ${total} 枚）`;
  }

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
  return { ok: true, values, input: { items, name: values.name, email: values.email, answers } };
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
      const typeIds = new Set(config.types.map((t) => t.id));
      for (const d of details) {
        const field = d && typeof d === "object" ? str((d as { field?: unknown }).field) : "";
        const reason = d && typeof d === "object" ? str((d as { reason?: unknown }).reason) : "";
        const key = detailKey(field, ids, typeIds);
        if (key) errors[key] = errors[key] ?? itemReasonMessage(key, reason);
      }
    }
    errors._form = "入力内容に誤りがあります。各項目をご確認ください。";
  } else if (status === 409) {
    const id = soldOutTypeId(body);
    if (id && config.types.some((t) => t.id === id)) errors[qtyInputName(id)] = "残数が足りません（売り切れ）";
    else errors.items = "選択された券種の残数が足りません";
    errors._form = "選択されたチケットの残数が足りなくなりました。枚数を減らすか、別の券種をお選びください。";
  } else if (status === 429) {
    errors._form = "ただいまお申し込みが集中しています。しばらく時間をおいて再度お試しください。";
  } else if (status === 503) {
    errors._form = "現在、決済の準備中です。有料チケットはしばらくお待ちください。";
  } else {
    errors._form = "お申し込みを処理できませんでした。時間をおいて再度お試しください。";
  }
  return errors;
}

function itemReasonMessage(key: string, reason: string): string {
  if (key === "items" && reason === "too_many") return `1 回のお申し込みは合計${ORDER_MAX}枚までです`;
  if (key === "items") return "チケットを 1 枚以上選んでください";
  if (!key.startsWith("qty_")) return "入力内容を確認してください";
  if (reason === "unavailable") return "この券種は現在お申し込みいただけません";
  if (reason === "too_many") return "選べる枚数を超えています";
  return "枚数を選び直してください";
}

/** 409 body: { error: { details: { reason: "sold_out", ticketTypeId } } } (array form tolerated). */
function soldOutTypeId(body: unknown): string | null {
  const err = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const details = err && typeof err === "object" ? (err as { details?: unknown }).details : undefined;
  const list = Array.isArray(details) ? details : [details];
  for (const d of list) {
    if (d && typeof d === "object" && typeof (d as { ticketTypeId?: unknown }).ticketTypeId === "string") {
      return (d as { ticketTypeId: string }).ticketTypeId;
    }
  }
  return null;
}

function detailKey(field: string, ids: Set<string>, typeIds: Set<string>): string | null {
  if (field === "items" || field === "ticketTypeId") return "items";
  if (field.startsWith("items.")) {
    const id = field.slice("items.".length);
    return typeIds.has(id) ? qtyInputName(id) : "items";
  }
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
.hero-canvas{position:absolute;inset:0;z-index:-3;width:100%;height:100%;display:block;opacity:0;transition:opacity 1.2s ease}
.hero.gl .hero-canvas{opacity:1}.hero.gl .blob,.hero.gl .net{display:none}
.hero::after{content:"";position:absolute;inset:0;z-index:-2;pointer-events:none;background:linear-gradient(90deg,rgba(4,8,30,.62) 0%,rgba(4,8,30,.25) 55%,transparent 80%),linear-gradient(180deg,transparent 60%,rgba(4,8,30,.45) 100%)}
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
.hero h1{font-family:var(--disp);font-weight:900;font-size:clamp(40px,7.4vw,84px);line-height:1.08;letter-spacing:.01em;margin:22px 0 18px;color:#fff;text-shadow:0 0 28px rgba(120,170,255,.35),0 4px 24px rgba(4,8,30,.5)}
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

/* day groups */
.days{display:grid;gap:34px}
.day-h{display:flex;align-items:center;gap:12px;margin:0 0 16px}
.day-k{display:inline-flex;align-items:center;gap:8px;font:900 13px/1 "Inter",sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#fff;background:var(--grad);border-radius:999px;padding:9px 15px;box-shadow:0 10px 20px -10px rgba(23,184,146,.7)}
.day-k.plain{background:#eef1f7;color:var(--soft);box-shadow:none}
.day-d{font-family:var(--disp);font-weight:900;font-size:20px;color:var(--h);letter-spacing:.02em;white-space:nowrap}
.day-h::after{content:"";flex:1;min-width:24px;height:1.5px;background:linear-gradient(90deg,rgba(16,28,168,.18),transparent)}

/* ticket cards (ticket-stub shape) with a quantity stepper on the stub */
.types{display:grid;gap:16px}
.tk{--nb:var(--bd);position:relative;display:grid;grid-template-columns:minmax(0,1fr) 196px;border-radius:18px;background:#fff;border:1.5px solid var(--nb);
transition:transform .25s cubic-bezier(.2,.7,.2,1),box-shadow .25s,border-color .2s,background .2s;box-shadow:var(--sh-md)}
.tk:hover{transform:translateY(-2px);box-shadow:var(--sh-lg);--nb:rgba(47,97,214,.35)}
.tk.on{--nb:var(--blue);box-shadow:0 0 0 4px rgba(47,97,214,.14),var(--sh-lg);background:linear-gradient(180deg,#fff 0%,#f4f8ff 100%)}
.tk:focus-within{--nb:var(--blue)}
.tk-main{padding:22px 24px 22px 26px;min-width:0;position:relative}
.tk-main::before{content:"";position:absolute;left:0;top:18px;bottom:18px;width:4px;border-radius:0 4px 4px 0;background:var(--grad);opacity:0;transition:opacity .2s}
.tk.on .tk-main::before{opacity:1}
.tk-name{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-family:var(--disp);font-weight:900;font-size:20px;color:var(--h);letter-spacing:.02em}
.tk-desc{display:block;color:var(--soft);font-size:14px;margin-top:6px}
.tk-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.tk-day{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:800;color:var(--deep);background:#eef4fd;border:1px solid rgba(47,97,214,.16);border-radius:999px;padding:4px 11px}
.tk-day svg{flex:none}
.tk-stub{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:18px 12px;border-left:2px dashed rgba(16,28,168,.14)}
.tk-stub::before,.tk-stub::after{content:"";position:absolute;left:-12px;width:22px;height:22px;border-radius:50%;background:#fff;border:1.5px solid var(--nb);transition:border-color .2s}
.tk-stub::before{top:-12px;clip-path:inset(50% 0 0 0)}
.tk-stub::after{bottom:-12px;clip-path:inset(0 0 50% 0)}
.tk-price{font:900 26px/1 "Inter",var(--disp);letter-spacing:-.01em;color:var(--h)}
.tk-price small{font:700 12px/1 var(--font);color:var(--mute);margin-left:3px;letter-spacing:0}
.tk-price.free{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;font-family:var(--disp);font-size:22px}
.qty{display:inline-flex;align-items:center;gap:4px;background:#f3f6fc;border:1.5px solid #d5dbe8;border-radius:999px;padding:4px;transition:border-color .2s,box-shadow .2s}
.qty:focus-within{border-color:var(--blue);box-shadow:0 0 0 4px rgba(47,97,214,.14)}
.tk.on .qty{background:#fff;border-color:rgba(47,97,214,.45)}
.qty select{width:auto;min-width:64px;border:0;border-radius:999px;background-color:transparent;box-shadow:none;text-align:center;text-align-last:center;font:800 18px/1.2 "Inter",var(--font);color:var(--h);padding:7px 30px 7px 14px;cursor:pointer;background-position:calc(100% - 16px) 52%,calc(100% - 10px) 52%}
.qty select:focus{box-shadow:none;background-color:transparent}
.js .qty select{min-width:46px;padding:7px 4px;background-image:none}
.qb{display:none;width:36px;height:36px;border-radius:50%;border:0;padding:0;background:#fff;color:var(--h);font:800 20px/1 "Inter",sans-serif;cursor:pointer;box-shadow:0 2px 6px -2px rgba(16,42,100,.2);place-items:center;transition:background .2s,color .2s,transform .15s,opacity .2s}
.js .qb{display:grid}
.qb:hover:not(:disabled){background:var(--grad);color:#fff;transform:scale(1.06)}
.qb:active:not(:disabled){transform:scale(.94)}
.qb:disabled{opacity:.35;cursor:not-allowed;box-shadow:none}
.tk-cap{font-size:11px;font-weight:700;color:var(--mute);letter-spacing:.02em}
.tk.off{box-shadow:none;background:#f8f9fb}
.tk.off:hover{transform:none;--nb:var(--bd)}
.tk.off .tk-name,.tk.off .tk-price{color:#8a93a6}.tk.off .tk-price.free{-webkit-text-fill-color:#8a93a6}
.tk.off .qty{opacity:.45}
.tk.bad{--nb:rgba(180,35,24,.45)}
.badge{display:inline-block;font:800 11px/1 var(--font);border-radius:999px;padding:5px 10px;background:#eceef2;color:var(--soft);letter-spacing:.04em}
.badge.so{background:#fde8e7;color:var(--err)}
.badge.low{background:#fff1d1;color:#8a5a00}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.items-err{margin-top:16px}

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
.sum-ev{font-size:13px;color:#b9c8ea;margin:0 0 18px;padding:0 0 16px;border-bottom:1px solid rgba(255,255,255,.12)}
.sum-list{list-style:none;margin:0;padding:0;display:grid;gap:14px}
.sum-list li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 12px;align-items:center;animation:rise .35s cubic-bezier(.2,.7,.2,1) both}
.sum-list .n{font-family:var(--disp);font-weight:900;font-size:16px;color:#fff;line-height:1.35}
.sum-list .q{grid-column:1;font-size:12px;color:#b9c8ea}
.sum-list .s{grid-column:2;grid-row:1/3;font:800 16px/1 "Inter",var(--disp);color:#fff}
.sum-empty{margin:0;font-size:14px;color:#b9c8ea;padding:10px 0}
.sum-cnt{display:flex;justify-content:space-between;align-items:baseline;margin:18px 0 0;padding:16px 0 0;border-top:1.5px dashed rgba(255,255,255,.2);font-size:13px;font-weight:700;color:#b9c8ea}
.sum-cnt b{font:800 16px/1 "Inter",var(--disp);color:#fff}
.sum-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin:12px 0 0}
.sum-row span{font-size:13px;font-weight:700;color:#b9c8ea}
.sum-warn{margin:12px 0 0;font-size:12px;font-weight:700;color:#ffd7a8}
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
.pass b{display:block;font-family:var(--disp);font-size:18px;font-weight:900;line-height:1.5}
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
.tk{grid-template-columns:1fr}.tk-main{padding:18px 18px 14px 20px}.tk-name{font-size:17px}.tk-price{font-size:20px}.tk-price.free{font-size:18px}
.tk-stub{flex-direction:row;flex-wrap:wrap;justify-content:space-between;padding:12px 16px 14px 20px;border-left:0;border-top:2px dashed rgba(16,28,168,.14)}
.tk-stub::before,.tk-stub::after{display:none}.tk-cap{width:100%;order:3}
.day-d{font-size:17px}.days{gap:28px}
.two{grid-template-columns:1fr}.ey2{display:none}.shead p{display:none}.bname{display:none}.steps li span{display:none}.steps li+li::before{width:14px}
}
@media (prefers-reduced-motion:reduce){
*,*::before,*::after{animation:none!important;transition:none!important}
html{scroll-behavior:auto}.ico .ck{stroke-dashoffset:0}.js .rv{opacity:1;transform:none}
}
`;

// Same raymarched blob field as the LP v3.1 hero (src/components/HeroScene.tsx), copied
// verbatim so this version-independent page matches the LP; keep the two in sync by hand.
const HERO_VERT = `attribute vec2 aPos;void main(){gl_Position=vec4(aPos,0.0,1.0);}`;
const HERO_FRAG = `
precision highp float;
uniform float uTime;
uniform float uScroll;
uniform vec2  uRes;
uniform vec3  uBlob[11]; // CPU-computed blob centers (hoisted, per-frame)

const int STEPS = 48;
const int NB = 11;

float smin(float a, float b, float k){
  float h = clamp(0.5 + 0.5*(b-a)/k, 0.0, 1.0);
  return mix(b, a, h) - k*h*(1.0-h);
}
mat3 rotY(float a){ float c=cos(a), s=sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
mat3 rotX(float a){ float c=cos(a), s=sin(a); return mat3(1.,0.,0., 0.,c,-s, 0.,s,c); }
float hash(float n){ return fract(sin(n)*43758.5453123); }

float map(vec3 p, float t, float morph){
  // organic domain warp → shapes are non-spherical and slowly morph (脈動)
  p += 0.18*morph*vec3(sin(p.y*1.3+t), sin(p.z*1.1+t*1.1), sin(p.x*1.2+t*0.9));
  float d = 1e5;
  for(int i=0;i<NB;i++){
    float fi = float(i);
    float r = 0.55 + 0.35*hash(fi+1.0) + 0.12*sin(t*0.9 + fi*2.0);
    d = smin(d, length(p - uBlob[i]) - r, 0.85);
  }
  return d;
}
// 4-tap tetrahedron gradient (was 6-tap central difference): visually identical
// normals for two fewer map() evaluations per lit pixel.
vec3 calcNormal(vec3 p, float t, float m){
  const vec2 k = vec2(1.0, -1.0);
  const float e = 0.0016;
  return normalize(
    k.xyy*map(p + k.xyy*e, t, m) +
    k.yyx*map(p + k.yyx*e, t, m) +
    k.yxy*map(p + k.yxy*e, t, m) +
    k.xxx*map(p + k.xxx*e, t, m));
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*uRes.xy)/uRes.y;
  float t = uTime;
  float scroll = uScroll;

  // NON-LINEAR scroll drivers
  float ease  = scroll*scroll*(3.0-2.0*scroll);   // smoothstep-ish
  float morph = 0.25 + ease*0.85;
  float rot   = t*0.05 + ease*2.2;                 // field rotation grows w/ scroll
  float dolly = ease*6.0;                           // camera pushes INTO the field
  float fov   = 1.0 + ease*0.35;

  vec3 ro = vec3(0.0, 0.0, 7.5 - dolly);
  vec3 rd = normalize(vec3(uv*fov, -1.3));
  mat3 rm = rotY(rot) * rotX(sin(t*0.07)*0.15 + ease*0.5);
  ro = rm*ro; rd = rm*rd;

  float dO = 0.0; bool hit=false; vec3 p = ro;
  for(int i=0;i<STEPS;i++){
    p = ro + rd*dO;
    float ds = map(p, t, morph);
    if(ds < 0.002){ hit=true; break; }
    dO += ds*0.9; // slightly larger stride keeps the same reach with fewer steps
    if(dO > 22.0) break;
  }

  vec3 bg = mix(vec3(0.02,0.05,0.16), vec3(0.05,0.11,0.32), uv.y*0.5+0.5);
  vec3 col = bg;

  if(hit){
    vec3 n = calcNormal(p, t, morph);
    vec3 L1 = normalize(vec3(0.6, 0.8, 0.4));
    vec3 L2 = normalize(vec3(-0.5, -0.3, 0.7));
    float dif  = max(dot(n, L1), 0.0);
    float dif2 = max(dot(n, L2), 0.0);
    float rim  = pow(1.0 - max(dot(n, -rd), 0.0), 2.5);

    vec3 blue = vec3(0.18, 0.38, 0.84);
    vec3 teal = vec3(0.09, 0.72, 0.57);
    vec3 base = mix(blue, teal, 0.5+0.5*sin(p.x*0.4 + p.y*0.3 + t*0.2));
    col  = base*(0.25 + 0.9*dif) + teal*dif2*0.35;
    col += rim*vec3(0.5, 0.75, 1.0)*0.9;

    float fog = 1.0 - exp(-0.055*dO*dO);          // depth fade (DOF/fog)
    col = mix(col, bg, fog*0.75);
  }

  // abstract warm focal glow (pulses) — evokes the reference's central light,
  // NOT a heart/mascot. Brightens a touch as you scroll in.
  float cd = length(uv);
  float glow = exp(-cd*cd*3.2) * (0.5 + 0.5*sin(t*0.8));
  col += vec3(0.95, 0.55, 0.28) * glow * 0.45 * (0.6 + 0.4*ease);

  col *= 1.0 - 0.24*dot(uv, uv);                   // vignette
  col = pow(max(col, 0.0), vec3(0.85));            // gamma
  gl_FragColor = vec4(col, 1.0);
}
`;

// Small, dependency-free progressive enhancement: live summary + submit spinner + reveal.
const SCRIPT = `(function(){var d=document;d.documentElement.classList.add("js");var HV=${JSON.stringify(HERO_VERT)},HF=${JSON.stringify(HERO_FRAG)};
function scene(V,F){var c=d.querySelector(".hero-canvas");if(!c)return;var sec=c.parentNode;
var red=matchMedia("(prefers-reduced-motion: reduce)").matches,mob=matchMedia("(max-width: 820px)").matches;
var gl=c.getContext("webgl",{antialias:false,alpha:false,depth:false})||c.getContext("experimental-webgl");if(!gl)return;
function sh(t,s){var x=gl.createShader(t);gl.shaderSource(x,s);gl.compileShader(x);return gl.getShaderParameter(x,gl.COMPILE_STATUS)?x:null}
var vs=sh(gl.VERTEX_SHADER,V),fs=sh(gl.FRAGMENT_SHADER,F),pr=gl.createProgram();if(!vs||!fs)return;
gl.attachShader(pr,vs);gl.attachShader(pr,fs);gl.bindAttribLocation(pr,0,"aPos");gl.linkProgram(pr);if(!gl.getProgramParameter(pr,gl.LINK_STATUS))return;gl.useProgram(pr);
var b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
var uT=gl.getUniformLocation(pr,"uTime"),uS=gl.getUniformLocation(pr,"uScroll"),uR=gl.getUniformLocation(pr,"uRes"),uB=gl.getUniformLocation(pr,"uBlob[0]"),bd=new Float32Array(33);
function rs(){var k=Math.min(window.devicePixelRatio||1,mob?1:1.25)*(mob?.6:.8);c.width=Math.max(1,Math.round(c.clientWidth*k));c.height=Math.max(1,Math.round(c.clientHeight*k));gl.viewport(0,0,c.width,c.height);gl.uniform2f(uR,c.width,c.height);if(!raf)draw()}
var st=0,se=0,t=0,lr=0,raf=0,on=true,iv=1000/(mob?30:40);
function rd(){st=Math.min(Math.max(window.scrollY/(sec.offsetHeight||1),0),1)*.6;if(red){se=st;draw()}}
function draw(){for(var i=0;i<11;i++){bd[i*3]=Math.sin(t*.35+i*1.7)*2.4+Math.cos(i*2.1)*1.2;bd[i*3+1]=Math.cos(t*.3+i*2.3)*1.8+Math.sin(i*1.3);bd[i*3+2]=Math.sin(t*.25+i*.9)*2.2-1+Math.cos(i*.7)*1.4}
gl.uniform3fv(uB,bd);gl.uniform1f(uT,t);gl.uniform1f(uS,se);gl.drawArrays(gl.TRIANGLES,0,3)}
function run(){return on&&!d.hidden&&!red}
function loop(n){raf=run()?requestAnimationFrame(loop):0;if(n-lr<iv-1)return;var dt=Math.min((n-lr)/1000,.1);lr=n;t+=dt;se+=(st-se)*(1-Math.pow(.92,Math.min(dt*60,4)));draw()}
function go(){if(run()&&!raf){lr=performance.now();raf=requestAnimationFrame(loop)}}
rs();rd();window.addEventListener("resize",rs);window.addEventListener("scroll",rd,{passive:true});
if("IntersectionObserver"in window)new IntersectionObserver(function(e){on=e[0].isIntersecting;go()}).observe(sec);
d.addEventListener("visibilitychange",go);c.addEventListener("webglcontextlost",function(e){e.preventDefault();on=false});
draw();sec.classList.add("gl");go()}
try{scene(HV,HF)}catch(e){}
var rv=[].slice.call(d.querySelectorAll(".rv"));if("IntersectionObserver"in window){var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add("in");io.unobserve(e.target)}})},{rootMargin:"0px 0px -8% 0px"});rv.forEach(function(el){io.observe(el)})}else rv.forEach(function(el){el.classList.add("in")});
var f=d.querySelector("form.buy");if(!f)return;var L=f.querySelector("[data-sum-lines]"),E=f.querySelector("[data-sum-empty]"),C=f.querySelector("[data-sum-count]"),T=f.querySelector("[data-sum-total]"),W=f.querySelector("[data-sum-warn]"),MX=+f.getAttribute("data-max")||20;
function yen(v){return v<=0?"無料":"¥"+v.toLocaleString("ja-JP")}
function mk(c,x){var e=d.createElement("span");e.className=c;e.textContent=x;return e}
function up(){var c=0,t=0;if(L)L.textContent="";[].forEach.call(f.querySelectorAll(".tk[data-id]"),function(k){var s=k.querySelector("select"),on=s&&!s.disabled,q=on?+s.value||0:0,p=+k.getAttribute("data-price")||0,m=k.querySelector(".qb[data-step='-1']"),P=k.querySelector(".qb[data-step='1']");
k.classList.toggle("on",q>0);if(m)m.disabled=!on||s.selectedIndex<=0;if(P)P.disabled=!on||s.selectedIndex>=s.options.length-1;
if(q>0&&L){c+=q;t+=p*q;var li=d.createElement("li"),dy=k.getAttribute("data-day");li.appendChild(mk("n",k.getAttribute("data-name")));li.appendChild(mk("s",yen(p*q)));li.appendChild(mk("q",(dy?dy+" · ":"")+yen(p)+" × "+q+"枚"));L.appendChild(li)}});
if(E)E.hidden=c>0;if(C)C.textContent=c+"枚";if(T)T.textContent=c>0?yen(t):"¥0";if(W)W.hidden=c<=MX}
f.addEventListener("click",function(e){var b=e.target&&e.target.closest?e.target.closest(".qb"):null;if(!b||b.disabled)return;var s=b.closest(".tk").querySelector("select");if(!s||s.disabled)return;var i=s.selectedIndex+(+b.getAttribute("data-step"));if(i<0||i>=s.options.length)return;s.selectedIndex=i;up()});
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
        ["券種と枚数", "参加者情報", "お支払い・完了"]
          .map((s, i) => `<li${i + 1 <= o.step! ? ' class="on"' : ""}><b>${i + 1}</b><span>${s}</span></li>`)
          .join("") +
        "</ol>";
  return (
    `<section class="hero${o.small ? " sm" : ""}">` +
    '<canvas class="hero-canvas" aria-hidden="true"></canvas>' +
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

export const PREVIEW_NOTE = "プレビュー表示中です。このページはまだ一般公開されていません（お申し込みはできません）。";

function shell(title: string, body: string, demo: boolean, preview = false): string {
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
    (preview ? `<div class="demo" role="note" data-lp-tk-preview>${PREVIEW_NOTE}</div>` : "") +
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

const CAL =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';

/** Quantity currently chosen for a type, clamped to what can be selected. */
function chosenQty(t: PublicTicketType, paymentReady: boolean, values: FormValues): number {
  const raw = values[qtyInputName(t.id)] ?? "";
  const q = /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
  return Math.min(q, maxQuantity(t, paymentReady));
}

function typeLabel(t: PublicTicketType): string {
  return t.dayLabel ? `${t.name}（${t.dayLabel}）` : t.name;
}

function renderType(t: PublicTicketType, paymentReady: boolean, values: FormValues, errors: FormErrors): string {
  const max = maxQuantity(t, paymentReady);
  const q = chosenQty(t, paymentReady, values);
  const key = qtyInputName(t.id);
  const k = escapeHtml(key);
  const soldOut = t.soldOut || t.remaining === 0;
  const badge = soldOut
    ? '<span class="badge so">売り切れ</span>'
    : max === 0
      ? '<span class="badge">決済準備中</span>'
      : t.remaining !== null && t.remaining <= LOW_STOCK
        ? `<span class="badge low">残りわずか ${t.remaining}枚</span>`
        : "";
  const price = formatPrice(t.priceJpy);
  const label = typeLabel(t);
  const aria = errors[key] ? ` aria-invalid="true" aria-describedby="${k}-err"` : "";
  const opts: string[] = [];
  for (let i = 0; i <= max; i++) opts.push(`<option value="${i}"${i === q ? " selected" : ""}>${i}</option>`);
  const select =
    `<label class="vh" for="${k}">${escapeHtml(label)} の枚数</label>` +
    `<select id="${k}" name="${k}"${max === 0 ? " disabled" : ""}${aria}>${opts.join("")}</select>`;
  const stepper =
    `<span class="qty">` +
    `<button type="button" class="qb" data-step="-1" aria-label="${escapeHtml(label)} を1枚減らす"${q <= 0 ? " disabled" : ""}>−</button>` +
    select +
    `<button type="button" class="qb" data-step="1" aria-label="${escapeHtml(label)} を1枚増やす"${q >= max ? " disabled" : ""}>＋</button>` +
    "</span>";
  const day = t.dayLabel ? splitDayLabel(t.dayLabel) : null;
  const cls = `tk${max === 0 ? " off" : ""}${q > 0 ? " on" : ""}${errors[key] ? " bad" : ""}`;
  return (
    `<div class="${cls}" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.name)}" data-day="${escapeHtml(day ? day.main : "")}" data-price="${Math.max(0, Math.trunc(t.priceJpy))}">` +
    `<div class="tk-main"><div class="tk-name">${escapeHtml(t.name)}${badge}</div>` +
    (t.description ? `<span class="tk-desc">${escapeHtml(t.description)}</span>` : "") +
    (day ? `<div class="tk-meta"><span class="tk-day">${CAL}対象日 ${escapeHtml(t.dayLabel)}</span></div>` : "") +
    errMsg(errors, key) +
    "</div>" +
    `<div class="tk-stub"><span class="tk-price${t.priceJpy <= 0 ? " free" : ""}">${escapeHtml(price)}${t.priceJpy > 0 ? "<small>/枚</small>" : ""}</span>` +
    stepper +
    (max > 0 ? `<span class="tk-cap">1 回 ${max} 枚まで</span>` : "") +
    "</div></div>"
  );
}

function renderDayGroups(config: TicketConfig, values: FormValues, errors: FormErrors): string {
  const groups = groupByDay(config.types);
  const onlyUndated = groups.length === 1 && groups[0].dayLabel === "";
  return (
    '<div class="days">' +
    groups
      .map((g) => {
        let head = "";
        if (g.dayLabel) {
          const d = splitDayLabel(g.dayLabel);
          head =
            `<h3 class="day-h"><span class="day-k">${escapeHtml(d.main)}</span>` +
            (d.sub ? `<span class="day-d">${escapeHtml(d.sub)}</span>` : "") +
            "</h3>";
        } else if (!onlyUndated) {
          head = '<h3 class="day-h"><span class="day-k plain">共通</span><span class="day-d">全日程</span></h3>';
        }
        const types = g.types.map((t) => renderType(t, config.paymentReady, values, errors)).join("");
        return `<section class="day" aria-label="${escapeHtml(g.dayLabel || "共通")}">${head}<div class="types">${types}</div></section>`;
      })
      .join("") +
    "</div>"
  );
}

/** Server-side order summary (same markup the inline script rebuilds live). */
function renderSummary(config: TicketConfig, values: FormValues): string {
  let count = 0;
  let total = 0;
  const lines: string[] = [];
  for (const t of config.types) {
    const q = chosenQty(t, config.paymentReady, values);
    if (q <= 0) continue;
    const p = Math.max(0, Math.trunc(t.priceJpy));
    count += q;
    total += p * q;
    const day = t.dayLabel ? splitDayLabel(t.dayLabel).main + " · " : "";
    lines.push(
      `<li><span class="n">${escapeHtml(t.name)}</span><span class="s">${escapeHtml(formatPrice(p * q))}</span>` +
        `<span class="q">${escapeHtml(day)}${escapeHtml(formatPrice(p))} × ${q}枚</span></li>`,
    );
  }
  return (
    `<ul class="sum-list" data-sum-lines>${lines.join("")}</ul>` +
    `<p class="sum-empty" data-sum-empty${count > 0 ? " hidden" : ""}>券種と枚数を選んでください</p>` +
    `<div class="sum-cnt" aria-live="polite"><span>合計枚数</span><b data-sum-count>${count}枚</b></div>` +
    `<div class="sum-row" aria-live="polite"><span>お支払い金額</span><b class="sum-price" data-sum-total>${count > 0 ? escapeHtml(formatPrice(total)) : "¥0"}</b></div>` +
    `<p class="sum-warn" data-sum-warn${count > ORDER_MAX ? "" : " hidden"}>1 回のお申し込みは合計${ORDER_MAX}枚までです</p>`
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
    sub: "日程ごとに券種と枚数を選び、必要事項を入力してお申し込みください。",
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
      config.preview,
    );
  }

  const hasPaid = config.types.some((t) => t.priceJpy > 0);
  const extra = config.fields.map((f) => renderField(f, values, errors)).join("");
  const form =
    `<form class="buy grid" method="post" action="/tickets/checkout" novalidate data-max="${ORDER_MAX}"><div>` +
    alerts +
    `<section class="card rv"><fieldset class="${errors.items ? "bad" : ""}"><legend>券種と枚数（必須）</legend>` +
    `<div class="shead"><span class="no">01</span><h2>券種と枚数を選ぶ</h2><p>1 回のお申し込みで合計 ${ORDER_MAX} 枚まで</p></div>` +
    renderDayGroups(config, values, errors) +
    (errors.items ? `<div class="items-err">${errMsg(errors, "items")}</div>` : "") +
    "</fieldset></section>" +
    '<section class="card rv"><div class="shead"><span class="no">02</span><h2>参加者情報</h2><p>確認メールをお送りします</p></div>' +
    `<div class="two">${fixedField("name", "氏名", values, errors)}${fixedField("email", "メールアドレス", values, errors)}</div>` +
    extra +
    `<div class="hp" aria-hidden="true"><label>空欄のままにしてください<input type="text" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></label></div>` +
    "</section></div>" +
    '<aside class="sum rv" aria-label="お申し込み内容"><div class="sum-card">' +
    '<p class="sum-k">YOUR ORDER</p>' +
    `<p class="sum-ev">${CONF_NAME}<br>${EVENT_DATE}</p>` +
    renderSummary(config, values) +
    '<button class="submit" type="submit">購入手続きへ<span class="ar" aria-hidden="true">→</span></button>' +
    (hasPaid ? `<p class="secure">${LOCK}カード決済は Stripe で安全に処理されます</p>` : "") +
    "</div>" +
    (hasPaid
      ? '<p class="note">有料チケットは Stripe の決済画面に移動してお支払いいただきます。無料チケットはそのままお申し込みが完了します。</p>'
      : "") +
    "</aside></form>";
  return shell("チケット購入", top + `<div class="body"><div class="wrap">${form}</div></div>`, !!o.demo, config.preview);
}

export type ThanksStatus = "paid" | "free" | "pending" | "expired" | "unknown";

const ICON_OK = '<div class="ico pop"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="ck" d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>';
const ICON_WAIT = '<div class="ico wait pop"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/></svg></div>';
const ICON_WARN = '<div class="ico warn pop"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v6M12 17h.01"/></svg></div>';

export function renderThanksPage(o: { status: ThanksStatus; summary?: string; demo?: boolean }): string {
  let inner: string;
  let acts = '<a class="btn1" href="/">トップへ戻る</a>';
  let step = 3;
  if (o.status === "paid" || o.status === "free") {
    inner =
      ICON_OK +
      "<h2>お申し込みが完了しました</h2>" +
      '<p class="lead">ご登録のメールアドレスに確認メールをお送りします。当日お会いできるのを楽しみにしています。</p>' +
      (o.summary
        ? '<div class="pass"><div><small>YOUR TICKETS</small>' +
          o.summary
            .split("、")
            .filter(Boolean)
            .map((x) => `<b>${escapeHtml(x)}</b>`)
            .join("") +
          "</div><i>CONFIRMED</i></div>"
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

export const CTA_SWAP_LABEL = "参加チケットを購入";
/** LP 参加登録 buttons (same markup in v3.4 / v3.5). */
export const CTA_SWAP_SELECTOR =
  ".site-head-cta,.hero-cta--participant,.svc-card--participant .svc-card-link,.git-btn--primary";

// Everything is keyed on [data-lp-tk], which only the script sets: with JS off nothing changes.
const CTA_SWAP_CSS =
  "[data-lp-tk]{cursor:pointer!important}" +
  "[data-lp-tk] .site-head-cta-badge,[data-lp-tk] .hero-cta-badge,[data-lp-tk] .git-btn-badge," +
  "[data-lp-tk] .svc-card-badge,[data-lp-tk] .svc-card-soon{display:none!important}" +
  ".svc-card-link[data-lp-tk] .svc-card-cta--disabled{color:var(--lp-blue-deep,#1e3fa8)!important;gap:.5rem}" +
  `.svc-card-link[data-lp-tk] .svc-card-cta--disabled::before{content:"${CTA_SWAP_LABEL}"}` +
  '.svc-card-link[data-lp-tk] .svc-card-cta--disabled::after,.git-btn--primary[data-lp-tk]::after{content:"\\2192";display:inline-grid;place-items:center;' +
  "width:2em;height:2em;border-radius:50%;font-size:.82em;line-height:1;transition:transform .24s cubic-bezier(.22,1,.36,1)}" +
  ".svc-card-link[data-lp-tk] .svc-card-cta--disabled::after{background:var(--lp-blue,#2f61d6);color:#fff}" +
  ".svc-card-link[data-lp-tk]:hover .svc-card-cta--disabled::after{transform:translateX(5px)}" +
  ".git-btn--primary[data-lp-tk]::after{position:absolute;right:1.1rem;top:50%;margin-top:-1em;background:#fff;color:var(--lp-blue-deep,#1e3fa8)}" +
  ".git-btn--primary[data-lp-tk]:hover::after{transform:translateX(3px)}" +
  // Dark hero: glass pill in the hero's cyan/teal (same family as 登壇に応募する), not the solid blue.
  ".hero--v31 .hero-cta--participant[data-lp-tk]{color:#fff;background:rgba(255,255,255,.14);" +
  "border:1.5px solid rgba(127,208,255,.62);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);" +
  "box-shadow:0 0 26px rgba(53,224,176,.18),inset 0 0 0 1px rgba(255,255,255,.06)}" +
  ".hero--v31 .hero-cta--participant[data-lp-tk]:hover,.hero--v31 .hero-cta--participant[data-lp-tk]:focus-visible{" +
  "color:#04102b;background:linear-gradient(120deg,#7fd0ff 0%,#35e0b0 100%);border-color:transparent;" +
  "box-shadow:0 16px 30px -6px rgba(53,224,176,.45)}" +
  "@media (prefers-reduced-motion:reduce){[data-lp-tk],[data-lp-tk]::after,[data-lp-tk] *::after{transition:none!important}}";

// Runs after React hydration (a __reactFiber$ key on the element) and edits the existing nodes in
// place: replacing/removing React-owned nodes, or rewriting server-side, would be undone by
// hydration. Gives up waiting after ~5s and swaps anyway.
const CTA_SWAP_SCRIPT =
  "(function(){var d=document,LB=" +
  JSON.stringify(CTA_SWAP_LABEL) +
  ',HREF="/tickets",SEL=' +
  JSON.stringify(CTA_SWAP_SELECTOR) +
  ",n=0;" +
  'function hyd(el){return Object.keys(el).some(function(k){return k.indexOf("__reactFiber$")===0})}' +
  "function txt(el){for(var c=el.firstChild;c;c=c.nextSibling){if(c.nodeType===3&&c.nodeValue.trim()){c.nodeValue=LB;return}}}" +
  "function go(e){if(e)e.preventDefault();location.href=HREF}" +
  'function swap(el){el.setAttribute("data-lp-tk","");el.classList.remove("is-disabled");el.removeAttribute("disabled");el.removeAttribute("aria-disabled");' +
  'if(el.tagName==="A")el.setAttribute("href",HREF);else{el.setAttribute("role","link");el.tabIndex=0}' +
  'if(el.hasAttribute("aria-label"))el.setAttribute("aria-label",LB);' +
  'var jp=el.querySelector(".git-btn-jp");if(jp)txt(jp);else if(!el.classList.contains("svc-card-link"))txt(el);' +
  'el.addEventListener("click",go);el.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "||e.key==="Spacebar")go(e)})}' +
  'function run(force){var all=d.querySelectorAll(SEL),left=0;[].forEach.call(all,function(el){if(el.hasAttribute("data-lp-tk"))return;if(force||hyd(el))swap(el);else left++});return all.length>0&&left===0}' +
  "(function tick(){n++;if(run(n>=50)||n>=50)return;setTimeout(tick,100)})()})();";

/** In-place swap of the LP's 参加登録 buttons to 参加チケットを購入 (-> /tickets). */
export function ticketsCtaSwap(): string {
  return `<style id="lp-tickets-cta-css">${CTA_SWAP_CSS}</style><script id="lp-tickets-cta-swap">${CTA_SWAP_SCRIPT}</script>`;
}

/** Fixed bar on LP pages while browsing with a preview link. */
export function ticketsPreviewBar(): string {
  return (
    '<div id="lp-tickets-preview" role="note" style="position:fixed;left:0;right:0;top:0;z-index:2147483647;' +
    "padding:6px 16px;background:#fff4d6;color:#7a4b00;text-align:center;" +
    "font:700 13px/1.5 'Zen Kaku Gothic New',system-ui,-apple-system,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.12)\">" +
    "チケット販売のプレビュー表示中です（一般には公開されていません）</div>"
  );
}

/** HTML appended to LP pages: floating CTA when enabled, plus the button swap when ctaEnabled too. */
export function ticketsInjection(cfg: TicketConfig | null): string {
  if (!cfg || !cfg.enabled) return "";
  return (cfg.preview ? ticketsPreviewBar() : "") + ticketsCta() + (cfg.ctaEnabled ? ticketsCtaSwap() : "");
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
      // Demo only (no real orders): the mock checkout passes its summary along in the URL.
      const summary = deps.demo && order ? (url.searchParams.get("summary") ?? "").slice(0, 300) : "";
      return htmlResponse(
        renderThanksPage({ status: deps.demo && order ? "free" : "unknown", summary: summary || undefined, demo: deps.demo }),
      );
    }
    // Never trust the query string: both paid (session_id) and free (order) are confirmed server-side.
    let status: ThanksStatus = "unknown";
    let summary: string | undefined;
    try {
      const res = await deps.internal("/lp/internal/tickets/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sessionId ? { sessionId } : { orderId: order }),
      });
      if (res.ok) {
        const b = (await res.json()) as { status?: unknown; summary?: unknown };
        if (b.status === "paid" || b.status === "pending" || b.status === "expired") status = b.status;
        if (typeof b.summary === "string" && b.summary.trim()) summary = b.summary.trim();
      }
    } catch {
      // fall through to the generic message
    }
    return htmlResponse(renderThanksPage({ status, summary: status === "paid" ? summary : undefined, demo: deps.demo }));
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
  if (config.preview) {
    const errors: FormErrors = { _form: "プレビュー表示中のため、お申し込みはできません。" };
    return htmlResponse(renderTicketsPage({ config, values: parsed.values, errors, demo: deps.demo }), 403);
  }
  if (deps.demo) {
    const summary = itemsSummary(parsed.input.items, config.types);
    return redirect(`/tickets/thanks?order=demo&summary=${encodeURIComponent(summary)}`);
  }
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
