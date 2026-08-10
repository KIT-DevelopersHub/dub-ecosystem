#!/usr/bin/env node
// mail-gateway send-test harness — send ONE real email through the configured managed
// provider, or (default) dry-run: assemble + print the exact upstream request WITHOUT
// sending. Mirrors the Worker's provider clients (resend.ts / mailchannels.ts / ses.ts)
// closely enough to validate credentials + domain auth end-to-end from a laptop, before
// the Worker is deployed.
//
// SAFETY: dry-run is the default. It NEVER sends unless BOTH `--send` is passed AND the
// selected provider's API key/creds are present in the environment. Secrets are REDACTED
// in all printed output.
//
// Usage:
//   # dry-run (no send), preview the Resend request:
//   MAIL_OUTBOUND_PROVIDER=resend MAIL_TEST_TO=you@example.com node scripts/send-test.mjs
//
//   # real send (requires the key AND --send):
//   MAIL_OUTBOUND_PROVIDER=resend RESEND_API_KEY=re_xxx \
//     MAIL_FROM_ADDRESS=info@developershub.jp MAIL_TEST_TO=you@example.com \
//     node scripts/send-test.mjs --send
//
// Env:
//   MAIL_OUTBOUND_PROVIDER  resend | mailchannels | ses   (default: resend)
//   MAIL_FROM_ADDRESS       verified From                 (default: info@developershub.jp)
//   MAIL_TEST_TO            recipient (required)
//   MAIL_TEST_SUBJECT       (default: "[mail-gateway] send-test <ISO>")
//   RESEND_API_KEY | MAILCHANNELS_API_KEY | SES_ACCESS_KEY_ID+SES_SECRET_ACCESS_KEY(+SES_REGION)
//   MAIL_SEND_TIMEOUT_MS    per-request timeout (default 15000)

import { webcrypto } from "node:crypto";
const subtle = webcrypto.subtle;

const args = new Set(process.argv.slice(2));
const doSend = args.has("--send");
const provider = (process.env.MAIL_OUTBOUND_PROVIDER || "resend").toLowerCase();
const from = process.env.MAIL_FROM_ADDRESS || "info@developershub.jp";
const to = process.env.MAIL_TEST_TO || "";
const subject = process.env.MAIL_TEST_SUBJECT || `[mail-gateway] send-test ${new Date().toISOString()}`;
const timeoutMs = Number(process.env.MAIL_SEND_TIMEOUT_MS || 15000);
const text = `mail-gateway send-test\nprovider: ${provider}\nfrom: ${from}\nsent-at: ${new Date().toISOString()}\n`;

const RED = "\x1b[31m", GRN = "\x1b[32m", YEL = "\x1b[33m", DIM = "\x1b[2m", RST = "\x1b[0m";
const log = (...a) => console.log(...a);
const fail = (m) => { console.error(`${RED}error:${RST} ${m}`); process.exit(1); };
const redact = (s) => (s && s.length > 6 ? `${s.slice(0, 3)}…${s.slice(-2)}` : "***");

if (!to) fail("MAIL_TEST_TO is required (the recipient of the test message).");

// ---- assemble the provider request (endpoint, headers, body) ----------------------
function buildResend() {
  const key = process.env.RESEND_API_KEY || "";
  return {
    hasCreds: !!key,
    endpoint: "https://api.resend.com/emails",
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    redactedHeaders: { "content-type": "application/json", authorization: `Bearer ${redact(key)}` },
    body: JSON.stringify({ from, to: [to], subject, text }),
    parseId: (j) => j?.id,
  };
}

function buildMailChannels() {
  const key = process.env.MAILCHANNELS_API_KEY || "";
  return {
    hasCreds: !!key,
    endpoint: "https://api.mailchannels.net/tx/v1/send",
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    redactedHeaders: { "content-type": "application/json", "x-api-key": redact(key) },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject,
      content: [{ type: "text/plain", value: text }],
    }),
    parseId: (j) => j?.message_ids?.[0] ?? j?.request_id,
  };
}

// --- minimal SigV4 (ports src/sigv4.ts using node:crypto webcrypto) ---
const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (s) => toHex(await subtle.digest("SHA-256", enc.encode(s)));
async function hmac(key, data) {
  const k = await subtle.importKey("raw", key instanceof Uint8Array ? key : new Uint8Array(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return subtle.sign("HMAC", k, enc.encode(data));
}
async function sigv4Headers({ host, path, region, service, accessKeyId, secretAccessKey, payload }) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(payload);
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-date";
  const canonicalRequest = ["POST", path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const kDate = await hmac(enc.encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));
  return {
    "content-type": "application/json",
    "x-amz-date": amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
async function buildSes() {
  const accessKeyId = process.env.SES_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.SES_SECRET_ACCESS_KEY || "";
  const region = process.env.SES_REGION || "ap-northeast-1";
  const host = `email.${region}.amazonaws.com`;
  const path = "/v2/email/outbound-emails";
  const mime = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="utf-8"', "", text, ""].join("\r\n");
  const body = JSON.stringify({ FromEmailAddress: from, Destination: { ToAddresses: [to] }, Content: { Raw: { Data: Buffer.from(mime, "utf8").toString("base64") } } });
  const hasCreds = !!(accessKeyId && secretAccessKey);
  const headers = hasCreds ? await sigv4Headers({ host, path, region, service: "ses", accessKeyId, secretAccessKey, payload: body }) : { "content-type": "application/json" };
  return {
    hasCreds,
    endpoint: `https://${host}${path}`,
    method: "POST",
    headers,
    redactedHeaders: { ...headers, authorization: headers.authorization ? headers.authorization.replace(/Credential=[^/]+/, `Credential=${redact(accessKeyId)}`).replace(/Signature=[0-9a-f]+/, "Signature=<redacted>") : `(unsigned — creds absent)` },
    body,
    parseId: (j) => j?.MessageId,
  };
}

const builders = { resend: buildResend, mailchannels: buildMailChannels, ses: buildSes };
if (!builders[provider]) fail(`unknown MAIL_OUTBOUND_PROVIDER="${provider}" (expected resend | mailchannels | ses)`);

const req = await builders[provider]();

// ---- print the plan (always) -------------------------------------------------------
log(`${DIM}mail-gateway send-test${RST}`);
log(`  provider : ${provider}`);
log(`  from     : ${from}`);
log(`  to       : ${to}`);
log(`  subject  : ${subject}`);
log(`  endpoint : ${req.method} ${req.endpoint}`);
log(`  headers  : ${JSON.stringify(req.redactedHeaders)}`);
log(`  body     : ${req.body}`);

if (!req.hasCreds) {
  log(`\n${YEL}dry-run:${RST} no credentials for "${provider}" in the environment — nothing sent.`);
  log(`         set the provider secret(s) and re-run with ${GRN}--send${RST} to actually deliver.`);
  process.exit(0);
}
if (!doSend) {
  log(`\n${YEL}dry-run:${RST} credentials present but ${GRN}--send${RST} not passed — nothing sent.`);
  log(`         re-run with --send to deliver one real message to ${to}.`);
  process.exit(0);
}

// ---- real send (--send AND creds present) ------------------------------------------
log(`\n${GRN}sending…${RST}`);
let res;
try {
  res = await fetch(req.endpoint, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(timeoutMs) });
} catch (err) {
  fail(`transport error: ${err?.message || err}`);
}
const bodyText = await res.text();
let json = null;
try { json = JSON.parse(bodyText); } catch { /* non-JSON */ }
if (!res.ok) {
  fail(`provider rejected (${res.status}): ${bodyText.slice(0, 300)}`);
}
const id = req.parseId(json);
log(`${GRN}sent${RST} — status ${res.status}, provider message id: ${id ?? "(none returned)"}`);
log(`\nnext: reply to that message from ${to} and confirm it lands in the inbound mailbox`);
log(`      (Email Routing -> Worker email() -> mail.message.received).`);
