// /receipt/<token>（領収書）。トークンは注文ごとの署名で、検証は lp-tickets だけが行う。
// チケットの URL（/t/<token>、同行者に転送される）とは別のトークンなので、チケットから領収書は開けない。
//
// 印刷前提の素の HTML（LP のヒーローや装飾は使わない）。宛名が空のときだけ 1 回入れられるフォームを出す。
// URL そのものが資格情報なので、ticket-pass.ts と同じ外へ漏らさないヘッダを付ける。
import {
  LP_TICKET_RECEIPT_NAME_MAX,
  type LpTicketReceipt,
} from "../../../packages/types/src/lp-tickets.ts";
import { escapeHtml } from "./html.ts";

const TOKEN_RE = "[A-Za-z0-9_-]{1,80}\\.[A-Za-z0-9_-]{24}";
const ROUTE_RE = new RegExp(`^/receipt/(${TOKEN_RE}|demo)/?$`);
const RECEIPT_TIMEOUT_MS = 3_000;
const BODY_MAX = 4 * 1024;

const RECEIPT_HEADERS: Record<string, string> = {
  "cache-control": "no-store, no-transform",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "content-security-policy": "frame-ancestors 'none'",
};

export type ReceiptRoute = { token: string | null };

export interface ReceiptDeps {
  demo: boolean;
  internal: ((path: string, init: RequestInit) => Promise<Response>) | null;
}

export const DEMO_RECEIPT: LpTicketReceipt = {
  orderNumber: "DEMO0001",
  status: "issued",
  receiptName: null,
  items: [{ ticketTypeId: "demo", ticketTypeName: "一般", dayLabel: "Day 1", unitPriceJpy: 3000, quantity: 2 }],
  amountJpy: 6000,
  taxJpy: null,
  paidAt: "2026-10-07T03:00:00.000Z",
  paymentMethod: "card",
  test: true,
  issuer: {
    name: "一般社団法人 Developers Hub",
    event: "北陸ITカンファレンス 2027",
    office: "北陸ITカンファレンス 2027 事務局",
    email: "info@developershub.jp",
    url: "https://developershub.jp",
    address: null,
    phone: null,
    invoiceRegistrationNo: null,
    taxRatePercent: 10,
  },
};

/** Everything under /receipt belongs here. A malformed path has token null: the same 404 as an unknown receipt. */
export function matchReceiptRoute(pathname: string): ReceiptRoute | null {
  if (pathname !== "/receipt" && !pathname.startsWith("/receipt/")) return null;
  const m = ROUTE_RE.exec(pathname);
  return { token: m ? m[1]! : null };
}

const yen = (n: number): string => `¥${n.toLocaleString("ja-JP")}`;

/** ISO -> "2026年10月7日"（日本時間）。 */
export function jstDate(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

const METHOD_LABEL: Record<string, string> = { card: "クレジットカード", paypay: "PayPay", link: "Link" };

const CSS = `*{box-sizing:border-box}body{margin:0;background:#f3f5f9;color:#1a2238;font-family:"Hiragino Kaku Gothic ProN","Hiragino Sans","Noto Sans JP","Yu Gothic",sans-serif;line-height:1.7}
.sheet{max-width:720px;margin:24px auto;background:#fff;padding:48px 40px;border:1px solid #d8deea}
h1{font-size:28px;letter-spacing:.5em;text-align:center;margin:0 0 32px}
.meta{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;font-size:14px}
.to{font-size:20px;border-bottom:1px solid #1a2238;padding-bottom:4px;min-width:60%}
.amount{margin:32px 0 8px;text-align:center;font-size:30px;font-weight:700;border:2px solid #1a2238;padding:12px}
.small{font-size:13px;color:#4a5370}
table{width:100%;border-collapse:collapse;margin:24px 0;font-size:14px}th,td{border:1px solid #c9d0de;padding:8px 10px;text-align:left}td.n{text-align:right;white-space:nowrap}
.issuer{margin-top:32px;text-align:right;font-size:14px}
.unset{color:#b42318;font-weight:700}
.void{color:#b42318;font-weight:700;text-align:center;border:2px solid #b42318;padding:8px;margin-bottom:24px}
.tools{max-width:720px;margin:0 auto 24px;padding:0 16px}
.tools form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0}
.tools input{flex:1;min-width:200px;font:inherit;font-size:16px;padding:10px 12px;border:1.5px solid #c9d0de;border-radius:8px}
.tools button{font:inherit;padding:10px 16px;border-radius:8px;border:0;background:#1f3a8a;color:#fff;cursor:pointer}
.err{color:#b42318}
@media (max-width:600px){.sheet{margin:0;padding:28px 16px;border:0}h1{font-size:22px}.amount{font-size:24px}}
@media print{body{background:#fff}.sheet{margin:0;border:0;padding:0}.tools{display:none}}`;

function doc(title: string, body: string): string {
  return (
    '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`
  );
}

const message = (title: string, lead: string): string =>
  doc(title, `<div class="sheet"><h1 style="letter-spacing:.1em">${escapeHtml(title)}</h1><p style="text-align:center">${escapeHtml(lead)}</p></div>`);

export function renderReceiptPage(r: LpTicketReceipt, token: string, error: string | null = null): string {
  const iss = r.issuer;
  const unset = (label: string) => `<span class="unset">【${label} 未設定】</span>`;
  const rows = r.items
    .map((i) => {
      const name = i.dayLabel ? `${i.ticketTypeName}（${i.dayLabel}）` : i.ticketTypeName;
      return `<tr><td>${escapeHtml(`${iss.event} 参加チケット ${name}`)}</td><td class="n">${escapeHtml(yen(i.unitPriceJpy))}</td><td class="n">${i.quantity}</td><td class="n">${escapeHtml(yen(i.unitPriceJpy * i.quantity))}</td></tr>`;
    })
    .join("");
  const method = r.paymentMethod ? (METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod) : null;
  const voidNote =
    r.status === "refunded"
      ? '<p class="void">この注文は返金済みのため、この領収書は無効です。</p>'
      : r.test
      ? '<p class="void">テスト購入のため、この領収書は無効です（実際の請求はありません）。</p>'
      : "";
  const nameForm =
    r.receiptName === null && r.status === "issued"
      ? `<form method="post" action="/receipt/${escapeHtml(token)}">` +
        `<label for="receiptName">宛名（会社名など）</label>` +
        `<input id="receiptName" name="receiptName" maxlength="${LP_TICKET_RECEIPT_NAME_MAX}" required placeholder="株式会社〇〇"${error ? ' aria-invalid="true" aria-describedby="rn-err"' : ""}>` +
        '<button type="submit">宛名を入れる</button></form>' +
        (error ? `<p class="err" id="rn-err">${escapeHtml(error)}</p>` : "") +
        '<p class="small">宛名は 1 回だけ入れられます（後から変更できません）。空欄のまま印刷することもできます。</p>'
      : "";
  const tools =
    `<div class="tools">${nameForm}` +
    '<p><button type="button" onclick="window.print()">印刷する / PDF に保存</button></p></div>';
  const sheet =
    '<div class="sheet">' +
    voidNote +
    "<h1>領収書</h1>" +
    '<div class="meta">' +
    `<div class="to">${r.receiptName ? escapeHtml(r.receiptName) : "&nbsp;"} 様</div>` +
    `<div>No. ${escapeHtml(r.orderNumber)}<br>発行日 ${escapeHtml(jstDate(r.paidAt))}</div></div>` +
    `<p class="amount">${escapeHtml(yen(r.amountJpy))} <span style="font-size:16px">（税込）</span></p>` +
    (r.taxJpy !== null ? `<p class="small" style="text-align:center">うち消費税（${escapeHtml(String(iss.taxRatePercent))}%） ${escapeHtml(yen(r.taxJpy))}</p>` : "") +
    `<p style="text-align:center">但し、${escapeHtml(iss.event)} 参加チケット代として<br>上記正に領収いたしました。</p>` +
    '<table><thead><tr><th>内容</th><th>単価（税込）</th><th>数量</th><th>金額（税込）</th></tr></thead>' +
    `<tbody>${rows}<tr><td colspan="3">合計</td><td class="n">${escapeHtml(yen(r.amountJpy))}</td></tr></tbody></table>` +
    `<p class="small">注文番号 ${escapeHtml(r.orderNumber)}・お支払い日 ${escapeHtml(jstDate(r.paidAt))}` +
    (method ? `・お支払い方法 ${escapeHtml(method)}` : "") +
    "</p>" +
    '<div class="issuer">' +
    `<div>${escapeHtml(iss.name)}</div>` +
    `<div>${escapeHtml(iss.office)}</div>` +
    `<div>${iss.address ? escapeHtml(iss.address) : unset("所在地")}</div>` +
    (iss.phone ? `<div>TEL ${escapeHtml(iss.phone)}</div>` : "") +
    `<div>${escapeHtml(iss.email)}</div>` +
    (iss.invoiceRegistrationNo ? `<div>登録番号 ${escapeHtml(iss.invoiceRegistrationNo)}</div>` : "") +
    "</div></div>";
  return doc(`領収書 ${r.orderNumber}`, sheet + tools);
}

function page(req: Request, html: string, status: number): Response {
  const headers = { ...RECEIPT_HEADERS, "content-type": "text/html; charset=utf-8" };
  return new Response(req.method === "HEAD" ? null : html, { status, headers });
}

const notFound = (req: Request): Response =>
  page(req, message("領収書が見つかりません", "URL が正しいか、メールをもう一度ご確認ください。"), 404);
const unavailable = (req: Request): Response =>
  page(req, message("ただいま表示できません", "時間をおいて、もう一度開いてください。"), 503);

type Loaded = LpTicketReceipt | "not_found" | "unavailable" | "conflict" | "invalid";

async function call(token: string, deps: ReceiptDeps, init: RequestInit): Promise<Loaded> {
  if (!deps.internal) return "unavailable";
  try {
    const res = await deps.internal(`/lp/internal/tickets/receipt/${encodeURIComponent(token)}`, {
      ...init,
      signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS),
    });
    if (res.status === 404) return "not_found";
    if (res.status === 409) return "conflict";
    if (res.status === 400) return "invalid";
    if (!res.ok) return "unavailable";
    return (await res.json()) as LpTicketReceipt;
  } catch {
    return "unavailable";
  }
}

async function readName(req: Request): Promise<string | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > BODY_MAX) return null;
  const text = await req.text();
  if (text.length > BODY_MAX) return null;
  return (new URLSearchParams(text).get("receiptName") ?? "").trim();
}

export async function handleReceipt(req: Request, route: ReceiptRoute, deps: ReceiptDeps): Promise<Response> {
  const method = req.method;
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { ...RECEIPT_HEADERS, allow: "GET, HEAD, POST" } });
  }
  const token = route.token;
  if (!token) return notFound(req);
  if (deps.demo) {
    if (token !== "demo") return notFound(req);
    return method === "POST" ? see(token) : page(req, renderReceiptPage(DEMO_RECEIPT, token), 200);
  }
  if (method === "POST") {
    const name = await readName(req);
    const error = !name ? "宛名を入力してください" : name.length > LP_TICKET_RECEIPT_NAME_MAX ? `宛名は${LP_TICKET_RECEIPT_NAME_MAX}文字以内で入力してください` : null;
    if (!error) {
      const set = await call(token, deps, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receiptName: name }),
      });
      if (set === "not_found") return notFound(req);
      if (set === "unavailable") return unavailable(req);
      // 設定済み（409）は今の領収書を見せるだけ。
      if (set !== "invalid") return see(token);
    }
    const current = await call(token, deps, {});
    if (typeof current === "string") return current === "not_found" ? notFound(req) : unavailable(req);
    return page(req, renderReceiptPage(current, token, error ?? "宛名に使えない文字が含まれています"), 400);
  }
  const r = await call(token, deps, {});
  if (r === "not_found") return notFound(req);
  if (typeof r === "string") return unavailable(req);
  return page(req, renderReceiptPage(r, token), 200);
}

/** Post/Redirect/Get: 再読み込みで二重送信しない。 */
function see(token: string): Response {
  return new Response(null, { status: 303, headers: { ...RECEIPT_HEADERS, location: `/receipt/${token}` } });
}
