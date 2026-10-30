// LP管理「プレビュー」のテスト購入トークン: "<exp>.<hmac>"（exp = unix 秒）。
// LP管理（ログイン + lp edit）だけが発行し、検証も lp-analytics だけが行う。鍵は Stripe の
// テストキーからラベル付き HMAC で導出するので、テストキーが無い（未設定・本番キー）環境では
// 発行も検証もできない = 本物の決済に化けない。
export const PREVIEW_TOKEN_TTL_SEC = 60 * 60;
const LABEL = "dub/lp-ticket-preview/v1";
const TOKEN_RE = /^(\d{1,12})\.([0-9a-f]{64})$/;

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: BufferSource, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
}

async function sign(secret: string, exp: number): Promise<string> {
  const derived = await hmac(new TextEncoder().encode(secret), LABEL);
  return hex(await hmac(derived, `${LABEL}.${exp}`));
}

export async function issuePreviewToken(secret: string, nowSec: number, ttlSec = PREVIEW_TOKEN_TTL_SEC): Promise<{
  token: string;
  expiresAt: number;
}> {
  const exp = nowSec + ttlSec;
  return { token: `${exp}.${await sign(secret, exp)}`, expiresAt: exp };
}

/** Valid = well-formed, signed with this secret, not expired, and not issued for longer than the TTL. */
export async function verifyPreviewToken(secret: string | null, token: unknown, nowSec: number): Promise<boolean> {
  if (!secret || typeof token !== "string") return false;
  const m = TOKEN_RE.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp <= nowSec || exp > nowSec + PREVIEW_TOKEN_TTL_SEC + 60) return false;
  const expected = await sign(secret, exp);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[2]!.charCodeAt(i);
  return diff === 0;
}
