// /t/<token>（チケットのページ）と /t/<token>/qr.png。トークンの検証は lp-tickets だけが行う。
// tickets.ts は依存ゼロのままにしたいので、QR の依存はこのファイルに閉じる。
//
// URL そのものが資格情報なので、外へ漏らさないヘッダを常に付ける。
// no-transform は、ゾーンで自動注入される Web Analytics のビーコンをこのページに入れないため
// （入ると URL が解析の画面に残る）。
// アプリのログイン導線（「アプリで開く」）はアプリの公開後にここへ足す。
import qrcode from "qrcode-generator";
import { CONF_NAME, escapeHtml, hero, shell } from "./tickets.ts";

const TOKEN_RE = "[A-Za-z0-9_-]{1,80}\\.[A-Za-z0-9_-]{24}";
const ROUTE_RE = new RegExp(`^/t/(${TOKEN_RE}|demo)(/qr\\.png)?/?$`);
const PASS_TIMEOUT_MS = 3_000;
const QR_SCALE = 6;
const QR_QUIET_MODULES = 4;

const PASS_HEADERS: Record<string, string> = {
  "cache-control": "no-store, no-transform",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "content-security-policy": "frame-ancestors 'none'",
};

export type PassRoute = { kind: "page" | "qr"; token: string | null };

export interface TicketPass {
  event: string;
  ticketTypeName: string;
  dayLabel: string;
  status: "valid" | "void";
  orderRef: string;
}

export interface PassDeps {
  demo: boolean;
  internal: ((path: string, init: RequestInit) => Promise<Response>) | null;
}

const DEMO_PASS: TicketPass = { event: CONF_NAME, ticketTypeName: "一般", dayLabel: "Day 1", status: "valid", orderRef: "DEMO0001" };

/** Everything under /t belongs here. A malformed path has token null: the same 404 as an unknown ticket. */
export function matchPassRoute(pathname: string): PassRoute | null {
  if (pathname !== "/t" && !pathname.startsWith("/t/")) return null;
  const m = ROUTE_RE.exec(pathname);
  return m ? { kind: m[2] ? "qr" : "page", token: m[1]! } : { kind: "page", token: null };
}

/** QR modules, true = dark. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 1-bit grayscale PNG with a quiet zone, QR_SCALE pixels per module. */
export async function matrixToPng(matrix: boolean[][]): Promise<Uint8Array> {
  const modules = matrix.length + QR_QUIET_MODULES * 2;
  const size = modules * QR_SCALE;
  const stride = Math.ceil(size / 8);
  const raw = new Uint8Array((stride + 1) * size).fill(0xff);
  for (let y = 0; y < size; y++) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter: none
    const my = Math.floor(y / QR_SCALE) - QR_QUIET_MODULES;
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / QR_SCALE) - QR_QUIET_MODULES;
      if (matrix[my]?.[mx]) raw[row + 1 + (x >> 3)]! &= ~(0x80 >> (x & 7));
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  ihdr[8] = 1; // bit depth
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", await deflate(raw)),
    pngChunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function page(req: Request, html: string, status: number): Response {
  const headers = { ...PASS_HEADERS, "content-type": "text/html; charset=utf-8" };
  return new Response(req.method === "HEAD" ? null : html, { status, headers });
}

function card(inner: string, ghost: string): string {
  return shell(
    "チケット",
    hero({ title: "Your <span class=\"g\">Ticket</span>", ghost, small: true, eyebrow: "TICKET" }) +
      `<div class="body"><div class="wrap"><section class="card done rv">${inner}</section></div></div>`,
    false,
  );
}

const notFound = (req: Request): Response =>
  page(
    req,
    card('<h2>チケットが見つかりません</h2><p class="lead">URL が正しいか、メールをもう一度ご確認ください。</p>', "TICKET"),
    404,
  );

const unavailable = (req: Request): Response =>
  page(req, card('<h2>ただいま表示できません</h2><p class="lead">時間をおいて、もう一度開いてください。</p>', "TICKET"), 503);

export function renderPassPage(pass: TicketPass, token: string): string {
  const name = escapeHtml(pass.dayLabel ? `${pass.ticketTypeName}（${pass.dayLabel}）` : pass.ticketTypeName);
  const ref = escapeHtml(pass.orderRef);
  if (pass.status !== "valid") {
    return card(
      `<h2>このチケットは無効です</h2><p class="lead">${name}・注文番号 ${ref}</p>` +
        '<p class="lead">返金などにより無効になりました。ご不明な点は事務局までお問い合わせください。</p>',
      "TICKET",
    );
  }
  return card(
    `<h2>${escapeHtml(pass.event)}</h2>` +
      `<img src="/t/${escapeHtml(token)}/qr.png" width="240" height="240" alt="チケットの QR コード" style="margin:20px auto 0;display:block">` +
      `<div class="pass"><div><small>YOUR TICKET</small><b>${name}</b></div><i>VALID</i></div>` +
      `<p class="lead" style="margin-top:20px">注文番号 ${ref}</p>` +
      '<p class="lead">この URL を知っている人は誰でもこのチケットを使えます。同行者の方にはその方の分だけを転送してください。</p>',
    "TICKET",
  );
}

async function loadPass(token: string, deps: PassDeps): Promise<TicketPass | "not_found" | "unavailable"> {
  if (deps.demo) return token === "demo" ? DEMO_PASS : "not_found";
  if (!deps.internal) return "unavailable";
  try {
    const res = await deps.internal(`/lp/internal/tickets/pass/${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(PASS_TIMEOUT_MS),
    });
    if (res.status === 404) return "not_found";
    if (!res.ok) return "unavailable";
    return (await res.json()) as TicketPass;
  } catch {
    return "unavailable";
  }
}

export async function handlePass(req: Request, route: PassRoute, deps: PassDeps): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { ...PASS_HEADERS, allow: "GET, HEAD" } });
  }
  if (!route.token) return notFound(req);
  const pass = await loadPass(route.token, deps);
  if (pass === "not_found") return notFound(req);
  if (pass === "unavailable") return unavailable(req);
  if (route.kind === "page") return page(req, renderPassPage(pass, route.token), 200);
  if (pass.status !== "valid") return notFound(req);
  const png = await matrixToPng(qrMatrix(`${new URL(req.url).origin}/t/${route.token}`));
  return new Response(req.method === "HEAD" ? null : png, { headers: { ...PASS_HEADERS, "content-type": "image/png" } });
}
