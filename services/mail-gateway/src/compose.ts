// Standalone "send-only" compose Worker (Part1 of the browser-send MVP).
//
// This is a self-contained lane that lets a human send ONE email from a browser:
//   GET  /              -> a minimal Japanese compose page (To / 件名 / 本文 / 送信)
//   POST /compose/send  -> hands {to, subject, text, html?} to the outbound provider
//
// It deliberately depends on NOTHING that the full mail-gateway needs to deploy:
//   - no D1 (no send-log; a browser one-shot does not need idempotency dedup)
//   - no SVC_IDENTITY service binding (auth is a single shared COMPOSE_TOKEN)
//   - no Queues (no event fan-out / audit)
// so `wrangler deploy -c wrangler.standalone.toml` succeeds with only Workers Secrets.
//
// Open-relay guard: /compose/send requires `Authorization: Bearer <COMPOSE_TOKEN>`
// AND a same-origin request (browser cross-origin is refused; no CORS is advertised).
import { Hono, type Context } from "hono";
import { DubError } from "@dub/errors";
import type { mail } from "@dub/types";
import { assembleMime } from "./mime";
import { ResendMailProvider, resendConfigFromEnv } from "./resend";
import { SesMailProvider, sesConfigFromEnv } from "./ses";
import { MailChannelsMailProvider, mailchannelsConfigFromEnv } from "./mailchannels";
import type { MailProvider, OutboundMail } from "./provider";
import { DEFAULT_FROM_ADDRESS, DEFAULT_OUTBOUND_PROVIDER } from "./config";

/** Bindings for the standalone worker — a minimal, self-sufficient subset. */
export interface ComposeEnv {
  /** Shared secret gating /compose/send (Workers Secret). Absent -> endpoint refuses. */
  COMPOSE_TOKEN?: string;
  /** "resend" | "ses" | "mailchannels" (default matches the full service). */
  MAIL_OUTBOUND_PROVIDER?: string;
  /** Default From (e.g. onboarding@resend.dev until DNS is live). */
  MAIL_FROM_ADDRESS?: string;
  // provider credentials (Workers Secrets; never committed)
  RESEND_API_KEY?: string;
  MAILCHANNELS_API_KEY?: string;
  SES_REGION?: string;
  SES_ACCESS_KEY_ID?: string;
  SES_SECRET_ACCESS_KEY?: string;
  MAIL_SEND_TIMEOUT_MS?: string;
}

type ComposeBindings = { Bindings: ComposeEnv };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Constant-time-ish string compare so a token check does not leak length via timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Same-origin guard: a cross-origin browser POST carries a mismatching Origin -> refuse.
 *  A non-browser client (curl) sends no Origin and is allowed (still needs the token). */
function isSameOrigin(c: Context<ComposeBindings>): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(c.req.url).origin;
  } catch {
    return false;
  }
}

/** Pick the outbound provider from env; null when its credentials are absent (loud 503). */
function buildComposeProvider(env: ComposeEnv): MailProvider | null {
  const name = (env.MAIL_OUTBOUND_PROVIDER ?? DEFAULT_OUTBOUND_PROVIDER).toLowerCase();
  if (name === "resend") {
    const cfg = resendConfigFromEnv(env as never);
    return cfg ? new ResendMailProvider(cfg) : null;
  }
  if (name === "mailchannels") {
    const cfg = mailchannelsConfigFromEnv(env as never);
    return cfg ? new MailChannelsMailProvider(cfg) : null;
  }
  const cfg = sesConfigFromEnv(env as never);
  return cfg ? new SesMailProvider(cfg) : null;
}

interface ComposeSendInput {
  to: mail.MailAddress[];
  subject: string;
  textBody: string;
  htmlBody: string | null;
}

/** Validate the tiny compose payload {to, subject, text, html?}. */
function parseComposeBody(body: unknown): ComposeSendInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const toRaw = typeof b.to === "string" ? b.to.trim() : "";
  const subject = typeof b.subject === "string" ? b.subject : "";
  const text = typeof b.text === "string" ? b.text : "";
  const html = typeof b.html === "string" && b.html.trim() !== "" ? b.html : null;

  if (!EMAIL_RE.test(toRaw)) throw new DubError("MAIL_INVALID_REQUEST", "宛先(to)が正しいメールアドレスではありません", { status: 400 });
  if (subject.length < 1) throw new DubError("MAIL_INVALID_REQUEST", "件名(subject)は必須です", { status: 400 });
  if (text.length < 1) throw new DubError("MAIL_INVALID_REQUEST", "本文(text)は必須です", { status: 400 });

  return { to: [{ email: toRaw }], subject, textBody: text, htmlBody: html };
}

export function createComposeApp() {
  const app = new Hono<ComposeBindings>();

  app.get("/", (c) => c.html(COMPOSE_HTML));
  app.get("/healthz", (c) => c.json({ status: "ok", service: "mail-gateway-standalone" }));

  app.post("/compose/send", async (c) => {
    // 1) open-relay guard: same-origin + shared bearer token.
    if (!isSameOrigin(c)) return c.json({ error: "cross-origin refused" }, 403);

    const token = c.env.COMPOSE_TOKEN;
    if (!token) return c.json({ error: "server misconfigured: COMPOSE_TOKEN unset" }, 500);

    const auth = c.req.header("authorization") ?? "";
    const presented = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (!presented || !timingSafeEqual(presented, token)) return c.json({ error: "unauthorized" }, 401);

    // 2) validate + send.
    let input: ComposeSendInput;
    try {
      input = parseComposeBody(await c.req.json().catch(() => null));
    } catch (err) {
      if (err instanceof DubError) return c.json({ error: err.message }, 400);
      throw err;
    }

    const provider = buildComposeProvider(c.env);
    if (!provider) return c.json({ error: "outbound provider not configured (missing API key)" }, 503);

    const from = c.env.MAIL_FROM_ADDRESS ?? DEFAULT_FROM_ADDRESS;
    const domain = from.split("@")[1] ?? "developershub.jp";
    const messageId = `${crypto.randomUUID()}@${domain}`;
    const outbound: OutboundMail = {
      from,
      to: input.to,
      cc: [],
      subject: input.subject,
      textBody: input.textBody,
      htmlBody: input.htmlBody,
      messageId,
      inReplyTo: null,
      mime: assembleMime({
        from,
        to: input.to,
        cc: [],
        subject: input.subject,
        textBody: input.textBody,
        htmlBody: input.htmlBody,
        messageId,
        inReplyTo: null,
      }),
    };

    try {
      const { providerMessageId } = await provider.send(outbound);
      return c.json({ ok: true, provider: provider.name, id: providerMessageId, from, to: input.to[0]!.email }, 200);
    } catch (err) {
      const status = err instanceof DubError ? err.status : 502;
      const message = err instanceof Error ? err.message : "provider send failed";
      return c.json({ ok: false, error: message }, (status ?? 502) as never);
    }
  });

  return app;
}

// ---- minimal compose page (self-contained; no external assets) --------------------
const COMPOSE_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>メール送信 (mail-gateway)</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
         margin: 0; padding: 2rem 1rem; background: #f5f6f8; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #14161a; color: #e8e8e8; } }
  .card { max-width: 640px; margin: 0 auto; background: #fff; border-radius: 12px;
          padding: 1.5rem; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  @media (prefers-color-scheme: dark) { .card { background: #20242b; } }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
  p.hint { margin: 0 0 1.25rem; font-size: .82rem; opacity: .7; }
  label { display: block; font-size: .82rem; font-weight: 600; margin: .9rem 0 .3rem; }
  input, textarea { width: 100%; padding: .55rem .65rem; border: 1px solid #cfd4dc;
    border-radius: 8px; font: inherit; background: transparent; color: inherit; }
  textarea { min-height: 140px; resize: vertical; }
  button { margin-top: 1.25rem; width: 100%; padding: .7rem; border: 0; border-radius: 8px;
    background: #2563eb; color: #fff; font-weight: 700; font-size: 1rem; cursor: pointer; }
  button:disabled { opacity: .55; cursor: default; }
  #status { margin-top: 1rem; font-size: .85rem; white-space: pre-wrap; word-break: break-all; }
  .ok { color: #12855b; } .err { color: #c0392b; }
</style>
</head>
<body>
  <div class="card">
    <h1>メール送信</h1>
    <p class="hint">mail-gateway 送信専用画面。送信トークンを貼り付けて 1 通送れます。</p>
    <label for="token">送信トークン (COMPOSE_TOKEN)</label>
    <input id="token" type="password" autocomplete="off" placeholder="発行されたトークンを貼り付け" />
    <label for="to">宛先 (To)</label>
    <input id="to" type="email" placeholder="account@developershub.jp" />
    <label for="subject">件名</label>
    <input id="subject" type="text" placeholder="件名を入力" />
    <label for="body">本文</label>
    <textarea id="body" placeholder="本文を入力"></textarea>
    <button id="send">送信する</button>
    <div id="status"></div>
  </div>
<script>
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  $("send").addEventListener("click", async () => {
    const token = $("token").value.trim();
    const to = $("to").value.trim();
    const subject = $("subject").value.trim();
    const text = $("body").value;
    statusEl.className = ""; statusEl.textContent = "";
    if (!token) { statusEl.className = "err"; statusEl.textContent = "送信トークンを入力してください"; return; }
    $("send").disabled = true; statusEl.textContent = "送信中...";
    try {
      const res = await fetch("/compose/send", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ to, subject, text }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        statusEl.className = "ok";
        statusEl.textContent = "送信成功 ✅\\nmessage id: " + (data.id || "?") + "\\nprovider: " + (data.provider || "?");
      } else {
        statusEl.className = "err";
        statusEl.textContent = "送信失敗 (" + res.status + "): " + (data.error || "unknown error");
      }
    } catch (e) {
      statusEl.className = "err"; statusEl.textContent = "通信エラー: " + (e && e.message ? e.message : e);
    } finally {
      $("send").disabled = false;
    }
  });
</script>
</body>
</html>`;
