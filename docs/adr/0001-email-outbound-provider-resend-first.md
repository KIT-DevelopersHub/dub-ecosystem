# ADR-0001: Outbound email provider — Resend first, SES for future/bulk

- Status: Accepted
- Date: 2026-08-10
- Deciders: DevHub (Dub) core
- Supersedes: the inline "SES暫定" note carried in `services/mail-gateway/src/*` code comments (which reference "ADR-001" before this file existed)

## Context

The `mail-gateway` service (namespace `mail`) is the single outbound/inbound email
boundary for the ecosystem. It exposes a frozen `SendMailRequest` / `SendMailResponse`
contract (`@dub/types` `mail` namespace) whose `provider` field is a closed union.
Inbound is handled by Cloudflare Email Routing; outbound needs a managed ESP because
Workers cannot open raw SMTP connections.

The design (P0b theme 9-B) originally recorded the provider as **"SES暫定"** (Amazon SES,
tentative) pending a user decision. The implementation therefore shipped three provider
adapters behind a common `MailProvider` interface (`services/mail-gateway/src/provider.ts`):

- `ses.ts` — Amazon SES via SigV4-signed `SendRawEmail` (we build the RFC822 MIME).
- `resend.ts` — Resend REST API (`POST https://api.resend.com/emails`), Bearer key;
  Resend builds its own MIME from structured fields.
- `mailchannels.ts` — MailChannels REST (raw MIME).

Each adapter is only activated when its credentials are present; otherwise a loud stub
stays. Provider selection is env-driven (`MAIL_OUTBOUND_PROVIDER`), and the current code
default constant is `DEFAULT_OUTBOUND_PROVIDER = "ses"`
(`services/mail-gateway/src/config.ts`).

Since then the decision has been finalized: **Resend is the first-choice provider**, with
SES reserved for the future / high-volume path.

### Why Resend first

- Fastest path to verified sending for a low-to-moderate volume (event/notification/mail
  automation) product; domain + DKIM setup is quick and the REST API needs no SigV4.
- No AWS account, IAM, or SES sandbox-exit process to manage for the initial launch.
- The adapter is already implemented and unit-tested (`test/resend.test.ts`).

### Why SES stays in the union (future / bulk)

- SES has materially lower per-message cost and higher throughput ceilings once volume
  grows, so keeping it as a first-class adapter avoids a future re-architecture.
- The provider abstraction already isolates the choice from the send core and the public
  contract, so switching or running both is a config/routing change, not a rewrite.

## Decision

1. **Resend is the default outbound provider** for DevHub (Dub). New environments provision
   Resend credentials and route outbound through the Resend adapter.
2. **SES remains a supported, first-class adapter** kept for the future high-volume / cost-
   sensitive path. It is not removed.
3. **MailChannels remains** as a third option in the union but is not the primary path.
4. Provider choice stays **env-driven** (`MAIL_OUTBOUND_PROVIDER`) so ops can switch without
   a code redeploy; the `provider` value is echoed back in `SendMailResponse` and stamped on
   `mail.message.sent` / `mail.message.send_failed` events for auditability.
5. Failure posture is **provider-agnostic and safe-side**: transport/non-2xx/empty-id →
   `MAIL_PROVIDER_UNAVAILABLE`, retried only on transient errors (network/timeout/429/5xx)
   with bounded exponential backoff; deterministic failures are never retried.

## Consequences

- Positive: launch does not depend on AWS/SES onboarding; the provider decision is reversible
  and multi-provider by construction.
- Negative / follow-up: **(要確認)** the code default constant is still
  `DEFAULT_OUTBOUND_PROVIDER = "ses"` and several source comments say "SES暫定". To match this
  ADR the default should flip to `"resend"` (and the `/config` health endpoint's fallback
  `provider ?? "ses"` reconsidered). This ADR records the decision only; the code change is a
  separate follow-up PR, not part of this docs change.
- The `SendMailResponse.provider` union (`"ses" | "mailchannels" | "resend"`) is unchanged;
  no contract break.
- **(要確認)** From-address / verified sending domain is `developershub.jp`
  (`DEFAULT_FROM_ADDRESS = "info@developershub.jp"`); DKIM/SPF/DMARC setup for Resend on that
  domain is an ops task tracked at Apply.

## Alternatives considered

| Option | Why not (as primary) |
|---|---|
| SES first | Requires AWS account + IAM + SES sandbox-exit before any launch send; higher setup cost for the initial low volume. Retained as the future/bulk adapter. |
| MailChannels first | Kept as an option, but Resend's structured API and current deliverability posture make it the better default. |
| Cloudflare Email Sending (native) | Considered for later; not adopted now to avoid re-plumbing the already-implemented, tested adapter set. Revisit if it reduces the SES/Resend split. |
