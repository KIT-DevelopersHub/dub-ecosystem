// Minimal AWS Signature V4 signer built on WebCrypto only — no aws4fetch / AWS SDK
// bundled (ADR-001: "Workers上で軽量・aws4fetch等で署名付きHTTPS"). Signs one HTTPS
// request and returns the headers to attach. Used by the SES v2 outbound provider.
// Keeps SES credentials off the request line and never logs them.

const encoder = new TextEncoder();

export interface Sigv4Input {
  method: string;
  host: string;
  path: string; // already URI-encoded canonical path (no query)
  service: string; // "ses"
  region: string; // "ap-northeast-1"
  accessKeyId: string;
  secretAccessKey: string;
  payload: string; // exact request body (signed)
  contentType?: string; // default application/json
  now?: Date; // injectable for deterministic tests
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// Copy into a fresh ArrayBuffer-backed view so the value is a plain BufferSource
// (avoids the TS ArrayBufferLike/SharedArrayBuffer generic mismatch on WebCrypto).
function bytes(data: string | ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  const src = typeof data === "string" ? encoder.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  return new Uint8Array(src);
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", bytes(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, bytes(data));
}

async function deriveSigningKey(secret: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = await hmac(encoder.encode(`AWS4${secret}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/** ISO instant -> AWS amz-date (YYYYMMDDTHHMMSSZ) + dateStamp (YYYYMMDD). */
function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Sign the request per AWS SigV4 and return the headers to send (content-type,
 * x-amz-date, authorization). Signed headers are the minimal set content-type;host;
 * x-amz-date — enough for SES v2 SendEmail with a JSON body.
 */
export async function signRequest(input: Sigv4Input): Promise<Record<string, string>> {
  const contentType = input.contentType ?? "application/json";
  const { amzDate, dateStamp } = amzDates(input.now ?? new Date());
  const payloadHash = await sha256Hex(input.payload);

  const canonicalHeaders = `content-type:${contentType}\nhost:${input.host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-date";
  const canonicalRequest = [input.method, input.path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  const signingKey = await deriveSigningKey(input.secretAccessKey, dateStamp, input.region, input.service);
  const signature = toHex(await hmac(signingKey, stringToSign));

  return {
    "content-type": contentType,
    "x-amz-date": amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
