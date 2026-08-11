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

### 3.3a Demo reset — wipe all inbox + sent rows (DESTRUCTIVE, secondary cleanup)

> Where the sample mail actually came from: the "weird demo mails" a viewer saw were the
> **fe2 client-side seed** (`apps/fe2-app-shell/.../gmail/mailModel.ts` `DEMO_THREADS`),
> rendered by the `/mail` GmailApp with no backend at all. That seed has been **removed
> from the live app** — the GmailApp now hydrates from the gateway (`GET /mail/messages` +
> `GET /mail/sent`), so a fresh load is clean by construction. This SQL is the **secondary
> cleanup** for any stray rows that a real smoke-test send / test receive left in D1.

To return the inbox + Sent folders to a clean, empty state at the **data** layer, run
`db/reset-demo.sql`. It only clears message rows (`mail_inbound`, `mail_send_log`); the
mailbox registry and Email Routing address config are untouched.

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

## 4. Workers free-tier verdict (9-E: is a paid plan required?)

**Conclusion: the outbound send endpoint runs on the Workers FREE plan. A paid plan is
required ONLY if you want the Queue-based event/audit fan-out.**

| Binding / feature | Plan | Needed for send? |
|---|---|---|
| Worker `fetch` (`POST /send`) | Free | Yes — works |
| D1 (send-log, inbound, mailboxes) | Free tier | Yes — works |
| Cron trigger (retention purge) | Free | No (housekeeping) |
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
- **Send log** (`mail_send_log`): every attempt is persisted (`pending → sent | failed`),
  purged after 30 days by the daily cron.
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
