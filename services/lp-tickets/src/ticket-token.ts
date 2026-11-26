// チケット URL のトークン: "<ticketId>.<sig>"。sig = HMAC-SHA256(TICKET_TOKEN_SECRET, ticketId) の先頭 18 バイト
// （144 bit）の base64url。トークンは保存せず毎回導出するので、DB やバックアップには資格情報が残らない。
const SIG_BYTES = 18;
const TOKEN_RE = /^([A-Za-z0-9_-]{1,80})\.([A-Za-z0-9_-]{24})$/;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(secret: string, ticketId: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(ticketId));
  return base64url(new Uint8Array(mac).slice(0, SIG_BYTES));
}

export async function ticketToken(secret: string, ticketId: string): Promise<string> {
  return `${ticketId}.${await sign(secret, ticketId)}`;
}

async function verify(secret: string | null, token: unknown, message: (id: string) => string): Promise<string | null> {
  if (!secret || typeof token !== "string") return null;
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const expected = await sign(secret, message(m[1]!));
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[2]!.charCodeAt(i);
  return diff === 0 ? m[1]! : null;
}

/** The ticket id of a genuine token, else null. Compared in constant time. */
export function verifyTicketToken(secret: string | null, token: unknown): Promise<string | null> {
  return verify(secret, token, (id) => id);
}

// 領収書 URL のトークン: "<orderId>.<sig>"。同じ鍵でも "receipt:" で署名対象を分けるので、
// チケットのトークン（同行者に転送される）から領収書は開けず、その逆もできない。
const receiptMessage = (orderId: string): string => `receipt:${orderId}`;

export async function receiptToken(secret: string, orderId: string): Promise<string> {
  return `${orderId}.${await sign(secret, receiptMessage(orderId))}`;
}

/** The order id of a genuine receipt token, else null. */
export function verifyReceiptToken(secret: string | null, token: unknown): Promise<string | null> {
  return verify(secret, token, receiptMessage);
}
