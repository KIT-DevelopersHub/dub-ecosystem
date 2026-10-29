# mail-gateway

Thin mail adapter for the Dub ecosystem (service #15). It does three things and owns no
business logic:

- **Outbound** `POST /send` — idempotent send through a managed provider (Resend / Amazon
  SES / MailChannels). One idempotency key = one delivery (二重送信ゼロ), with bounded
  retry on transient provider failures.
- **Inbound** — Cloudflare Email Routing delivers to the Worker `email()` handler, which
  normalizes the RFC822 message and publishes `mail.message.received` (受信取りこぼしゼロ;
  `Message-Id` dedup makes a redelivery a no-op).
- **Read/admin** — `GET /messages`, `/threads/:id`, `/mailboxes` (permission-gated).

This document is the **Go-Live runbook**: how to send real mail from `developershub.jp`
today, fastest path first.

---

## 0. TL;DR — fastest Go-Live (Resend, free)

1. Create a Resend account, add the domain `developershub.jp`, copy the DNS records it
   shows into Cloudflare DNS (all **DNS-only / grey-cloud**). Wait for "Verified".
2. `wrangler secret put RESEND_API_KEY` and set `MAIL_OUTBOUND_PROVIDER = "resend"`.
3. Fill the D1 `database_id` in `wrangler.toml`, then `wrangler deploy`.
4. `GET /internal/health/ready` (header `x-dub-internal: 1`) must return `200 ready:true`.
5. `MAIL_OUTBOUND_PROVIDER=resend RESEND_API_KEY=… MAIL_TEST_TO=you@example.com pnpm
   send-test --send` — one real email.

Free tier is enough for the **send endpoint** (Resend free = 100/day, 3000/month; Workers
Free plan runs the Worker). See §4 for the paid-vs-free verdict.

---

## 1. Provider comparison

| Provider | Cost to start | Setup effort | Notes |
|---|---|---|---|
| **Resend** (recommended, default) | Free 100/day, 3000/mo | Lowest | Copy-paste DNS from dashboard; Bearer API key. Best first Go-Live. Code default when `MAIL_OUTBOUND_PROVIDER` is unset (ADR-0001). |
| **Amazon SES** | ~$0 (62k/mo from AWS infra tiers vary) | Medium | Sandbox by default (verified recipients only) → request production access. SigV4, no SMTP. Supported path for future/high-volume. |
| **MailChannels** | Paid | Medium | Free Cloudflare-Workers integration was discontinued (mid-2024); now needs a paid MailChannels account + API key + Domain Lockdown TXT. |

All three are already implemented (`src/resend.ts`, `src/ses.ts`, `src/mailchannels.ts`).
Switch by changing `MAIL_OUTBOUND_PROVIDER` and putting that provider's secret — no code
change.

---

## 2. Domain authentication (SPF / DKIM / DMARC)

Deliverability requires the sending domain to authenticate. You add DNS records in the
**Cloudflare dashboard → developershub.jp → DNS → Records → Add record**. Set every mail
auth record to **DNS only (grey cloud)** — never proxy TXT/MX/DKIM.

> The exact record VALUES are generated per-account by the provider. Do not invent them —
> copy what the provider's dashboard shows. The shapes below tell you what to expect and
> where to paste it.

### Resend

Resend's "Domains → Add Domain" screen prints the exact records. Typically:

| Type | Name (host) | Value (example shape) |
|---|---|---|
| TXT (SPF) | `send.developershub.jp` | `v=spf1 include:amazonses.com ~all` |
| TXT/CNAME (DKIM) | `resend._domainkey.developershub.jp` | provider-generated `p=…` key |
| MX (feedback) | `send.developershub.jp` | `feedback-smtp.<region>.amazonses.com` prio 10 |
| TXT (DMARC, recommended) | `_dmarc.developershub.jp` | `v=DMARC1; p=none; rua=mailto:dmarc@developershub.jp` |

Paste each into Cloudflare DNS, then click **Verify** in Resend. Green = ready to send.

### Amazon SES

1. SES console → **Verified identities → Create identity → Domain** `developershub.jp`,
   enable **Easy DKIM**. SES gives **three CNAME** records:
   `<token1>._domainkey.developershub.jp → <token1>.dkim.amazonses.com` (and 2 more).
   Add all three to Cloudflare DNS (DNS only).
2. SPF (via a custom MAIL FROM subdomain, recommended): TXT on `mail.developershub.jp` =
   `v=spf1 include:amazonses.com ~all`, plus the MX SES shows for that subdomain.
3. DMARC: TXT `_dmarc.developershub.jp` = `v=DMARC1; p=none; rua=mailto:dmarc@developershub.jp`.
4. **Leave the sandbox**: SES starts in *sandbox* (can only send to verified addresses,
   low quota). Open **Account dashboard → Request production access**, describe the use
   case. Until granted, `send-test --send` only works to a verified recipient.
5. Region: `SES_REGION` defaults to `ap-northeast-1` (Tokyo). Verify the identity in the
   **same** region.

### MailChannels

1. Paid MailChannels account → generate an API key (`MAILCHANNELS_API_KEY`).
2. **Domain Lockdown** TXT `_mailchannels.developershub.jp` = `v=mc1 auth=<your-account-id>`.
3. SPF: include `include:relay.mailchannels.net`. DKIM: publish your key at
   `mailchannels._domainkey.developershub.jp` and configure it in the API payload.

---

## 3. Secrets and deploy

### 3.1 Secret names (values NEVER committed — set with `wrangler secret put`)

| Provider | Secret name(s) |
|---|---|
| Resend | `RESEND_API_KEY` |
| Amazon SES | `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` |
| MailChannels | `MAILCHANNELS_API_KEY` |

Non-secret config lives in `wrangler.toml [vars]`: `MAIL_OUTBOUND_PROVIDER`,
`MAIL_FROM_ADDRESS`, `SES_REGION`, and the tuning knobs `MAIL_SEND_MAX_ATTEMPTS` /
`MAIL_SEND_TIMEOUT_MS`.

```
# example, Resend:
wrangler secret put RESEND_API_KEY        # paste re_… when prompted
```

### 3.2 Deploy steps

1. **D1**: use the existing `dub-core` DB (or `wrangler d1 create dub-core`) and put its
   `database_id` into `wrangler.toml` (replace `PLACEHOLDER_DUB_CORE_D1_ID`). Apply the
   schema in `db/0001_mail.sql`, then every forward-only migration in id order
   (`db/0002_inbound_body_read.sql`, `db/0003_freeq_outbox.sql`, `db/0004_send_body.sql`).
   `0004` adds the body/recipient columns that back the **Sent** folder (additive
   `ALTER TABLE ... ADD COLUMN`, all nullable — safe on a populated DB, no data loss).
2. **Provider**: set `MAIL_OUTBOUND_PROVIDER` in `[vars]` and put the matching secret(s).
3. **Inbound** (optional but recommended): Cloudflare → developershub.jp → **Email →
   Email Routing** → enable, add address `info@developershub.jp` → action **Send to a
   Worker → mail-gateway**. Email Routing auto-manages the inbound MX/SPF records.
4. `wrangler deploy`.
5. **Verify**: `curl -H 'x-dub-internal: 1' https://<worker>/internal/health/ready` →
   `200` with `"ready": true`. A `503` lists exactly what is missing (no secrets leaked).
6. **Smoke send**: `pnpm send-test --send` (see §5).

### 3.3a Demo reset — wipe all inbox + sent rows (DESTRUCTIVE)

The "weird demo mails" a viewer sees are **live rows in D1** (leftover smoke-test sends +
test receives), not seed code. To return the inbox + Sent folders to a clean, empty state
for a demo/screenshot, run `db/reset-demo.sql`. It only clears message rows
(`mail_inbound`, `mail_send_log`); the mailbox registry and Email Routing address config
are untouched.

> WARNING: destructive and irreversible. For the **deploy owner** to run against a
> demo/staging DB only. Never run it against a database holding real received/sent mail.

```
# 1) Dry run against a LOCAL copy first (no remote writes):
wrangler d1 execute dub-core --local --file=db/reset-demo.sql

# 2) Apply to the remote demo DB (deploy owner only):
wrangler d1 execute dub-core --remote --file=db/reset-demo.sql
```

(`dub-core` is the DB name in `wrangler.toml`.) There is intentionally **no** HTTP purge
endpoint — a remotely reachable "delete all mail" route is too dangerous for prod.

---

## 3.3 Email Routing admin (address issuance + forwarding rules)

The admin console manages `@developershub.jp` addresses and forwarding rules through this
service, which proxies the **Cloudflare Email Routing API** (rather than opening the
Cloudflare dashboard). Surface (all `mail:admin`, reachable via api-gateway as
`/api/v1/mail/admin/email-routing/*`):

| Method + path | Cloudflare API |
|---|---|
| `GET /admin/email-routing/addresses` | list account destination addresses |
| `POST /admin/email-routing/addresses` | create destination address (CF sends a verify mail) |
| `DELETE /admin/email-routing/addresses/:id` | delete destination address |
| `GET /admin/email-routing/rules` | list zone routing rules |
| `POST /admin/email-routing/rules` | create rule (localpart matcher → forward action) |
| `PATCH /admin/email-routing/rules/:id` | update rule (enable/disable, matchers, actions) |
| `DELETE /admin/email-routing/rules/:id` | delete rule |

Every mutation is written to the audit log (`mail.email_routing.*`, success/failure).
Rule matchers are constrained to the managed zone (anti-spoof) and local parts to a strict
charset (anti-abuse).

**Token (Workers Secret, NEVER committed):**

```
wrangler secret put CF_EMAIL_ROUTING_TOKEN   # paste the API token when prompted
```

Required token scopes (create at Cloudflare → My Profile → API Tokens):

| Scope | Why |
|---|---|
| **Account → Email Routing Addresses → Edit** | destination addresses are account-scoped |
| **Zone → Email Routing Rules → Edit** (on `developershub.jp`) | routing rules are zone-scoped |

Non-secret ids go in `wrangler.toml [vars]` (safe to commit): `CF_EMAIL_ROUTING_ZONE_ID`
(developershub.jp zone id), `CF_EMAIL_ROUTING_ACCOUNT_ID` (account id),
`CF_EMAIL_ROUTING_ZONE_NAME` (default `developershub.jp`).

**Until the token is set, every admin endpoint returns `503 MAIL_EMAIL_ROUTING_UNCONFIGURED`**
(fails loud, never a silent no-op). `GET /internal/health/ready` reports
`emailRouting.configured` / `zoneConfigured` / `accountConfigured` (booleans only — the
token value is never echoed).

---

## 3.4 Gmail safety-net forward (`MAIL_GMAIL_FORWARD`)

Every inbound copy is stored first; then, when `MAIL_GMAIL_FORWARD = "on"`, the Worker also
calls `message.forward(<名簿 Gmail>)` for the **envelope recipient** (`src/gmail-forward.ts`).

- **Who**: the roster user of the envelope address (`identity-roster /internal/users/lookup`)
  whose 運営メンバー row is linked (`member_people.identity_user_id`) and has a `gmail`
  (`member-service /members/internal/google-emails`). No link / no Gmail = skipped.
- **Multi-recipient**: Email Routing invokes `email()` once per envelope recipient, so a mail
  To/CC'd to several Dub users forwards to each one's own Gmail once. Header To/CC are never
  used (would double-forward and could leak a BCC).
- **Loop guards**: a copy carrying `X-Dub-Forwarded` is never re-forwarded (we stamp it);
  a target on our own zone and mail sent *from* the target Gmail are skipped; the archive
  address is never forwarded.
- **Failure isolation**: a forward failure (e.g. unverified destination) is caught, logged
  (`gmail forward failed`, masked address) and audited as `mail.message.forward_gmail`
  (`failure`). It never drops or blocks storage. The forward also runs when ingest threw
  (the ingest error is re-thrown afterwards, as before).
- **Default OFF**: the var is unset in `wrangler.free.toml`, so merging/deploying changes nothing.

### Enabling (manual, owner approval required)

`message.forward()` only delivers to addresses **verified** as Email Routing destination
addresses. Adding one sends a verification mail to that member, so each step needs approval.

1. List targets (read-only): `SELECT p.gmail FROM member_people p JOIN identity_users u ON
   u.id = p.identity_user_id WHERE TRIM(COALESCE(p.gmail,'')) <> ''`.
2. Add each as a destination address — either
   - Dashboard: Cloudflare → developershub.jp → Email → Email Routing → **Destination
     addresses** → *Add destination address*; or
   - API (token with **Account › Email Routing Addresses › Edit**):
     `POST /accounts/{account_id}/email/routing/addresses` body `{"email":"<gmail>"}`.
3. Each member clicks the verification link Cloudflare mails them (status becomes
   *Verified*; check via `GET /accounts/{account_id}/email/routing/addresses`).
   Unverified members simply get `failed` audit rows until they verify — no data impact.
4. Set `MAIL_GMAIL_FORWARD = "on"` in `[vars]` of `wrangler.free.toml` and deploy through the
   normal flow (or `wrangler secret put MAIL_GMAIL_FORWARD` for an out-of-band toggle).
5. Verify: send a test mail to a verified member, confirm it is in the Dub inbox and in the
   Gmail (check Spam), and that the Worker log shows `gmail forward forwarded`.

Disable: remove the var (or set anything other than `on`) and redeploy.

## 3.5 Archive forward (`MAIL_ARCHIVE_FORWARD_TO`)

Independent of §3.4: when `MAIL_ARCHIVE_FORWARD_TO` is set (prod: `dub.developershub@gmail.com`
in `wrangler.free.toml`), every inbound mail is stored first and then forwarded to that one
address.

- **Once per Message-ID**: Email Routing invokes `email()` once per Dub recipient. Only the
  invocation that newly stored the `mail_inbound` row forwards (later recipients dedup to
  `processed=false` and skip). Ingest failure → forward anyway. A mail without Message-ID
  gets a unique synthetic id, so it forwards on every invocation.
- **Headers**: `X-Dub-Forwarded: archive` and `X-Dub-Original-Rcpt: <envelope recipient of
  the forwarding invocation>`. Other recipients of the same mail are visible in its To/CC.
- **Loop guards**: skip if `X-Dub-Forwarded` is present or the sender is the archive address.
- **Failure isolation**: a rejected forward (e.g. the address is not yet verified) is logged
  (`archive forward failed`) and audited as `mail.message.forward_archive` (`failure`, masked
  address); storage and the Gmail forward are unaffected.

One-time setup: Cloudflare dashboard → developershub.jp → Email → Email Routing →
**Destination addresses** → *Add destination address* → `dub.developershub@gmail.com`, then
open the verification mail in that Gmail and click the link (status → *Verified*).

## 3.6 本番の合成メール監視 (canary)

本番と同じ経路で「送って・届いたか」を定期確認する外形監視（`src/canary.ts`）。**既定は OFF**。

- 動作: 既存の 5 分 cron に相乗り（新しい trigger は無し）。`MAIL_CANARY_INTERVAL_MIN`（既定 15）分ごとに
  件名 `[dub-canary] <uuid>` のメールを通常の送信コア（Resend）で To=`MAIL_CANARY_TO` / Cc=`MAIL_CANARY_CC`
  に送り、以降の tick で `mail_inbound` を Message-ID か件名トークンで探す。宛先ごとの到着は
  `header_meta_json.deliveredTo` で判定し、`MAIL_CANARY_DEADLINE_MIN`（既定 10）分で確定する。
  結果は `mail_canary_probe`（migration 0014）に1行ずつ記録。
- 隔離: QA アドレス2つだけに送る / archive の自動 CC を付けない / system 送信（owner なし）なので、
  メンバーの受信箱・送信済みには出ない（`mail:read_all` の全件表示には出る）。受信コピーは archive 転送もしない。
  QA アドレスは名簿（roster）に登録しないこと。
- 判定: 既定は「どちらかのコピーが `mail_inbound` に入れば OK」。現状は Message-ID ごとに1行しか持てず
  2通目（多くは Cc）が捨てられるため `cc_ok=0` が記録されるが、それではアラートしない。
  Cc の修正後に `MAIL_CANARY_EXPECT_CC="true"` にすると To と Cc の両方を必須にする。
- 通知: 2回連続で失敗した時点で audit `mail.canary.alert`（+ error ログ）を1回だけ、その後の最初の成功で
  `mail.canary.recovered` を出す。
- 確認: `GET /api/v1/mail/admin/canary/probes?limit=50`（`mail:admin`、読み取り専用）。
- 有効化: (1) Email Routing で QA アドレス2つを「Worker に送る（dub-mail-gateway）」ルールで作成
  (2) migration `0017_mail_canary_probe.sql` を適用 (3) `MAIL_CANARY_ENABLED="true"` /
  `MAIL_CANARY_TO` / `MAIL_CANARY_CC` を vars に設定してデプロイ。
- コスト注意: 15 分間隔だと 1日 96 送信 ≒ 月 2,880 送信。Resend 無料枠（100/日・3,000/月）をほぼ使い切るので、
  無料枠のままなら間隔を 60 分などに延ばす。

## 3.7 Resend の配送エラー → 管理者アラート（webhook）

Resend は宛先が Suppressions（送信停止リスト）に載っていると **送信 API には 200 を返したまま黙って捨てる**。
これを拾うため、Resend の webhook を受けて管理者に通知する（`src/resend-webhook.ts`）。

- 経路: Resend → api-gateway `POST https://dub-api-gateway.developershub-site.workers.dev/api/v1/public/webhooks/resend`（PUBLIC・本文をバイト列のまま転送）
  → mail-gateway `POST /internal/webhooks/resend`（INTERNAL）。Svix 署名（`svix-id` / `svix-timestamp` / `svix-signature`、
  HMAC-SHA256、±5分）をここで検証。`RESEND_WEBHOOK_SECRET` 未設定なら **503**（fail closed・error ログ）、
  `/internal/health/ready` の `deliveryWebhook` にも出る。
- 対象イベント: `email.bounced` / `email.suppressed` / `email.failed` / `email.complained` / `email.delivery_delayed`（それ以外は 200 で無視）。
- 記録: `mail_provider_event`（migration 0019）に svix-id を主キーで1行。再送は 200 の no-op（二重通知なし）。
  `provider_message_id`（= Resend の email_id）で `mail_send_log` と突合し、件名・送信ログ id を補う。
- 通知: 自ドメイン（`CF_EMAIL_ROUTING_ZONE_NAME`、既定 developershub.jp）宛ては **毎回**、外部宛ては同じ宛先につき **24時間に1回**。
  チャネルは canary と同じ audit（`mail.delivery.alert`）+ error ログ、さらに `SVC_NOTIFICATION` があれば
  `role_sys_admin` / `role_sys_maintainer` へアプリ内通知（`POST /notify`、type `mail.delivery_alert`）。
  メール通知はしない（壊れている経路そのものに乗るため）。
- 本文（日本語）: 宛先 / イベント / 理由（例: 宛先が存在しない・送信停止リスト）/ 件名 / 日時(JST) /
  対処「Cloudflare Email Routing の受け口を確認 → Resend の Suppressions から外す」。

### セットアップ手順（運用者）

1. migration `0019_mail_provider_event.sql` を dub-core に適用。
2. Resend ダッシュボード → **Webhooks** → *Add Webhook*
   - Endpoint URL: `https://dub-api-gateway.developershub-site.workers.dev/api/v1/public/webhooks/resend`
   - Events: `email.bounced` / `email.complained` / `email.delivery_delayed` / `email.failed` / `email.suppressed`
   - 作成後の **Signing Secret**（`whsec_...`）をコピー。
3. `npx wrangler secret put RESEND_WEBHOOK_SECRET --config services/mail-gateway/wrangler.free.toml` に貼り付け。
4. mail-gateway / api-gateway をデプロイ（`SVC_NOTIFICATION` binding は wrangler.free.toml に追加済み）。
5. Resend の webhook 画面の *Send test* で 200 を確認（`email.delivered` 等は無視されて `ignored: true`）。

## 4. Workers free-tier verdict (9-E: is a paid plan required?)

**Conclusion: the outbound send endpoint runs on the Workers FREE plan. A paid plan is
required ONLY if you want the Queue-based event/audit fan-out.**

| Binding / feature | Plan | Needed for send? |
|---|---|---|
| Worker `fetch` (`POST /send`) | Free | Yes — works |
| D1 (send-log, inbound, mailboxes) | Free tier | Yes — works |
| Cron trigger (予約送信 drain) | Free | No (scheduled send only) |
| Email Routing (inbound) | Free | No (only for inbound) |
| **Cloudflare Queues** (`EVT_*`, `AUDIT_QUEUE` producers) | **Paid ($5/mo)** | **No** |

Cloudflare Queues need the **Workers Paid** plan. The send core publishes
`mail.message.sent/send_failed` + audit records to those queues **best-effort**: a publish
failure is logged and swallowed (`safePublish` in `src/send.ts`), so **the send still
returns `202` even when the queues are absent**. That makes a free-tier, send-only deploy
viable.

To deploy send-only on the Free plan, **comment out the three `[[queues.producers]]`
blocks** in `wrangler.toml` (a Worker with queue bindings won't deploy without the Paid
plan). Trade-off: `notification` / `mail-automation` / `audit-log` consumers are not fed —
the send itself is unaffected. Re-enable the queues (and upgrade to Paid) when you want the
full event/audit fan-out and inbound-driven automation.

---

## 5. Send-test harness

`scripts/send-test.mjs` (`pnpm send-test`) assembles and, on demand, sends ONE real email
through the configured provider — mirroring the Worker's provider clients. **Dry-run is the
default**; it never sends unless BOTH `--send` is passed AND the provider's key is present.
Secrets are redacted in all output.

```
# dry-run (prints the exact upstream request, sends nothing):
MAIL_OUTBOUND_PROVIDER=resend MAIL_TEST_TO=you@example.com pnpm send-test

# real send (needs the key AND --send):
MAIL_OUTBOUND_PROVIDER=resend RESEND_API_KEY=re_xxx \
  MAIL_FROM_ADDRESS=info@developershub.jp MAIL_TEST_TO=you@example.com \
  pnpm send-test --send
```

Supports `resend`, `mailchannels`, and `ses` (full SigV4). Env knobs: `MAIL_FROM_ADDRESS`,
`MAIL_TEST_TO` (required), `MAIL_TEST_SUBJECT`, `MAIL_SEND_TIMEOUT_MS`.

---

## 6. Behavior reference (what "production-ready" means here)

- **Idempotency**: `Idempotency-Key` header is required. Same key + same body = one
  delivery (replay returns the first result); same key + different body = `409`; concurrent
  sends collapse via `UNIQUE(idempotency_key)`. See `src/send.ts`.
- **Retry / backoff**: a transient provider failure (network reset, request timeout, HTTP
  `429`, HTTP `5xx`) is retried with exponential backoff + full jitter, up to
  `MAIL_SEND_MAX_ATTEMPTS` (default 3). Deterministic failures (`4xx` validation, unverified
  domain, `2xx`-without-id, bad signing key) fail fast. See `src/retry.ts`.
- **Per-attempt timeout**: each provider call is aborted after `MAIL_SEND_TIMEOUT_MS`
  (default 15s) so a hung upstream can't wedge the Worker; the abort is treated as retryable.
- **Send log** (`mail_send_log`): every attempt is persisted (`pending → sent | failed`)
  and kept indefinitely (no retention purge).
- **Readiness**: `GET /internal/health/ready` (internal-only) reports the selected provider,
  whether its credentials are present, the effective From, and the tuning — `200 ready:true`
  or `503` with a secret-free issue list.
- **Rate-limit visibility**: a provider `429` is raised as its own code
  `MAIL_RATE_LIMITED` (HTTP 429, `retryable:true`) carrying the provider's `Retry-After` as
  `details.retryAfterSec` — distinct from a generic `502`. `GET /internal/status`
  (internal-only) derives a `rateLimit` view from the send-log so the admin UI can surface
  "directly rate-limited": `{ active, code, since, recoversAt, cooldownSec }`. A send is
  considered still limited for `MAIL_RATE_LIMIT_COOLDOWN_SEC` (default 60, range 5..86400)
  after the last `429`. The FE renders this via `@dub/ui` `RateLimitNotice`.
- **Safe-side failure**: mail is never silently dropped. A misconfigured provider serves a
  loud stub that throws; a send failure records the row, publishes `mail.message.send_failed`,
  audits it, and returns `502`.

---

## 7. Known limitations / roadmap (not blocking Go-Live)

- **Bounces / complaints**: hard bounces and complaints arriving back as email (DSN /
  `mailer-daemon`) are captured by the inbound path as regular messages (the
  `Auto-Submitted` header is stored). A structured feedback loop (SES SNS notifications or
  Resend webhooks → suppression list) is **not** implemented; it needs a webhook endpoint +
  storage and is tracked as follow-up. For launch scale (a few hundred/day) manual review of
  the inbound mailbox is sufficient.
- **Rate limiting / quota guard**: the service does not enforce a per-day cap itself; it
  relies on the provider's quota (Resend 100/day) and returns the provider's `429` (which the
  retry loop backs off on). A local token-bucket guard would need KV/DO (Paid) and is
  deferred.
- **Outbound reply-through-CF**: not used; outbound is always the managed provider.

---

## Development

```
pnpm --filter @dub/mail-gateway test        # vitest (unit + integration)
pnpm --filter @dub/mail-gateway typecheck   # tsc --noEmit
```
